"""Real executor callbacks and service futures, run by the ROS_ONLY runner."""

import threading
import time
import json

import pytest
import rclpy
import rclpy.experimental
from rclpy.executors import SingleThreadedExecutor
from rclpy.node import Node
from rclpy.parameter import Parameter
from rcl_interfaces.srv import GetParameters, SetParameters
from sensor_msgs.msg import Joy, LaserScan
from ackermann_msgs.msg import AckermannDriveStamped
from geometry_msgs.msg import PoseStamped
from nav_msgs.msg import OccupancyGrid, Odometry
from std_msgs.msg import String
from drive_intent import schema
from rclpy.qos import QoSProfile, DurabilityPolicy

from web_dashboard.dashboard_node import DashboardNode, _TuningTarget, _make_executor


@pytest.fixture
def nodes():
    rclpy.init()
    dashboard = DashboardNode()
    peer = Node('dashboard_executor_test_peer')
    yield dashboard, peer
    dashboard.destroy_node()
    peer.destroy_node()
    rclpy.try_shutdown()


def spin_until(executor, predicate):
    deadline = time.monotonic() + 5
    while not predicate() and time.monotonic() < deadline:
        executor.spin_once(timeout_sec=0.02)
    assert predicate(), 'executor failed to deliver callbacks within 5 seconds'


def test_events_executor_delivers_subscription_timers_services_and_done_callbacks(nodes):
    dashboard, peer = nodes
    executor = _make_executor(dashboard)
    executor.add_node(dashboard)
    executor.add_node(peer)
    try:
        # oracle: spec prefer the available Jazzy EventsExecutor, not the wait-set executor.
        assert type(executor).__name__ == 'EventsExecutor'
        scan = LaserScan(ranges=[1.25, 2.5])
        pose = PoseStamped()
        pose.pose.position.x = 2.0
        pose.pose.orientation.w = 1.0
        drive = AckermannDriveStamped()
        drive.drive.speed = 1.5
        odom = Odometry()
        odom.twist.twist.linear.x = 1.25
        grid = OccupancyGrid(data=[0, 100])
        grid.info.width, grid.info.height = 2, 1
        grid.info.resolution = 0.05
        grid.info.origin.orientation.w = 1.0
        latched = QoSProfile(depth=1, durability=DurabilityPolicy.TRANSIENT_LOCAL)
        inputs = [
            (dashboard.scan_topic, scan, 10),
            (dashboard.drive_topic, drive, 10),
            (dashboard.odom_topic, odom, 10),
            (dashboard.joy_topic, Joy(buttons=[0, 0, 0, 0, 1]), 10),
            (dashboard.map_topic, grid, latched),
            (dashboard.controller_topic, String(data='gap_follow_node'), latched),
            (dashboard.racing_line_topic, String(data=json.dumps(
                {'points': [[0, 0], [1, 1]]})), latched),
            (dashboard.intent_topic, String(data=schema.encode(schema.build(
                'gap_follow_node', 'gap_follow', reason='executor test'))), 10),
        ] + [(topic, pose, 10) for topic in dashboard.pose_topics]
        publishers = [(peer.create_publisher(type(msg), topic, qos), msg)
                      for topic, msg, qos in inputs]

        def publish_inputs():
            for publisher, message in publishers:
                publisher.publish(message)

        timer = peer.create_timer(0.02, publish_inputs)
        dashboard.request_map_refresh()
        dashboard.request_process_refresh()
        spin_until(executor, lambda: dashboard._last_scan_msg is not None
                   and dashboard._last_stats is not None
                   and dashboard._last_process_json is not None
                   and dashboard._last_map_list_json is not None
                   and dashboard._last_pose is not None
                   and dashboard._last_drive is not None
                   and dashboard._last_speed is not None
                   and dashboard._last_intent is not None
                   and dashboard._last_racing_line is not None
                   and dashboard._map_streamer.has_map()
                   and dashboard._map_requests.empty()
                   and dashboard._process_requests.empty())
        # oracle: invariant real subscription values survive and all periodic state is sampled.
        assert list(dashboard._last_scan_msg.ranges) == [1.25, 2.5]
        assert dashboard._last_stats[3] > 0
        assert dashboard._last_pose == (2.0, 0.0, 0.0)
        assert dashboard._last_drive == (1.5, 0.0)
        assert dashboard._last_speed == 1.25
        assert dashboard._last_intent['state'] == 'gap_follow'
        assert dashboard._active_controller == 'gap_follow_node'
        assert dashboard._last_racing_line['points'] == [[0, 0], [1, 1]]
        peer.destroy_timer(timer)

        peer.declare_parameter('bench_value', 1.5)
        peer.declare_parameter('live_tunable_spec', json.dumps({
            'version': 1, 'params': [{'name': 'bench_value', 'group': 'Test',
                                     'kind': 'float', 'min': 0, 'max': 4}]}))
        target = _TuningTarget(peer.get_name(), [], None)
        dashboard._tuning_targets.append(target)
        # The real refresh timer discovers the peer and completes its catalogue/value futures.
        spin_until(executor, lambda: target.values.get('bench_value') == 1.5)
        get, set_ = target.get_client, target.set_client
        spin_until(executor, lambda: get.service_is_ready() and set_.service_is_ready())
        thread_ids = []
        update = set_.call_async(SetParameters.Request(parameters=[
            Parameter('bench_value', value=2.75).to_parameter_msg()]))
        update.add_done_callback(lambda _: thread_ids.append(threading.get_ident()))
        spin_until(executor, lambda: update.done() and bool(thread_ids))
        query = get.call_async(GetParameters.Request(names=['bench_value']))
        spin_until(executor, query.done)
        # oracle: invariant set/get service futures execute on the spin thread and retain values.
        assert update.result().results[0].successful
        assert query.result().values[0].double_value == 2.75
        assert thread_ids == [threading.get_ident()]
        dashboard.request_tuning_set(peer.get_name(), 'bench_value', 3.25)
        spin_until(executor, lambda: peer.get_parameter('bench_value').value == 3.25
                   and target.values.get('bench_value') == 3.25)
        assert peer.get_parameter('bench_value').value == 3.25
    finally:
        executor.shutdown()


def test_constructor_failure_falls_back_to_a_working_single_threaded_executor(nodes, monkeypatch):
    dashboard, peer = nodes

    def unavailable():
        raise RuntimeError('deliberately unavailable executor')

    monkeypatch.setattr(rclpy.experimental, 'EventsExecutor', unavailable)
    executor = _make_executor(dashboard)
    executor.add_node(dashboard)
    try:
        # oracle: spec construction failure retains the previous single-threaded executor.
        assert isinstance(executor, SingleThreadedExecutor)
        spin_until(executor, lambda: dashboard._last_stats is not None)
        assert dashboard._last_stats[3] > 0
    finally:
        executor.shutdown()


def test_unwatched_telemetry_retains_latest_state_for_a_connecting_viewer(nodes):
    dashboard, _ = nodes
    pose = PoseStamped()
    pose.pose.orientation.w = 1.0
    drive = AckermannDriveStamped()
    odom = Odometry()
    for value in (1.0, 3.0):
        pose.pose.position.x = value
        drive.drive.speed = value
        drive.drive.steering_angle = value / 10
        odom.twist.twist.linear.x = value + 0.5
        dashboard.pose_callback(pose)
        dashboard.drive_callback(drive)
        dashboard.odom_callback(odom)
        dashboard.intent_callback(String(data=schema.encode(schema.build(
            'gap_follow_node', 'gap_follow', desired_speed=value,
            commanded_speed=value, reason='bench'))))

    class Viewer:
        def __init__(self):
            self.frames = []

        def send(self, header, payload=None):
            self.frames.append(header)

    viewer = Viewer()
    dashboard.ws_clients.add(viewer)
    dashboard.send_initial_state(viewer)
    frames = {header['type']: header for header in viewer.frames}
    # oracle: invariant new viewers receive the latest unwatched state, not the first input.
    assert frames['pose']['x'] == 3.0
    assert frames['drive']['speed'] == 3.0
    assert frames['drive']['steering_angle'] == 0.3
    assert frames['speed']['speed'] == 3.5
    assert frames['intent']['intent']['desired_speed'] == 3.0
    assert frames['tuning_armed']['armed'] is False
    assert frames['stopwatch']['running'] is False
    # Watched callbacks must still queue updates for the configured telemetry tick.
    drive.drive.speed = 4.0
    dashboard.drive_callback(drive)
    with dashboard._batch_lock:
        batch = dashboard._batcher.flush()
    assert next(item for item in batch['items'] if item['type'] == 'drive')['speed'] == 4.0
