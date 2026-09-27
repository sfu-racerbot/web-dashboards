"""
The real DashboardNode, constructed with no YAML at all: what a team gets
before writing its own car config.

Two things are pinned here:
  * the optional intent panel, at the node: with drive_intent installed the
    node subscribes to /drive_intent; without it, it subscribes to nothing
    there and every other subscription still exists;
  * generic defaults (the spec is the migration decision recorded in
    car/README.md, "Write your car's YAML"): no car's node names, paths or
    geometry ship in the package. Car 2's values live in its own workspace
    (racerbot_launch/config/web_dashboard_rb2.yaml).

Needs rclpy (and drive_intent for the "installed" case), so it runs under
colcon on a car, NOT in this repo's ROS-free CI. The node publishes to no
topic, but it still joins the ROS graph -- run it on an isolated domain:

    ROS_DOMAIN_ID=79 ROS_AUTOMATIC_DISCOVERY_RANGE=LOCALHOST \\
        python3 -m pytest car/ros/web_dashboard/test/test_dashboard_node_defaults.py -v
"""
import sys

import pytest
import rclpy

from web_dashboard.dashboard_node import DashboardNode


@pytest.fixture
def make_node():
    nodes = []

    def _make():
        rclpy.init()
        node = DashboardNode()
        nodes.append(node)
        return node

    yield _make
    for node in nodes:
        node.destroy_node()
    if rclpy.ok():
        rclpy.shutdown()


def _subscribed_topics(node):
    return {sub.topic_name for sub in node.subscriptions}


def test_with_drive_intent_installed_the_intent_topic_is_subscribed(make_node):
    node = make_node()
    assert node.intent_enabled is True
    assert '/drive_intent' in _subscribed_topics(node)


def test_without_drive_intent_nothing_subscribes_and_the_rest_still_does(make_node, monkeypatch):
    for name in [n for n in sys.modules if n == 'drive_intent' or n.startswith('drive_intent.')]:
        monkeypatch.delitem(sys.modules, name)
    monkeypatch.setitem(sys.modules, 'drive_intent', None)
    node = make_node()
    topics = _subscribed_topics(node)
    assert node.intent_enabled is False
    assert node.intent_sub is None
    assert '/drive_intent' not in topics
    # Everything else is still wired: the map, the scan, both default pose
    # topics, the selected command, speed and LB state.
    for topic in ('/map', '/scan', '/pf/viz/inferred_pose', '/slam_pose',
                  '/ackermann_cmd', '/odom', '/joy'):
        assert topic in topics, topic


def test_the_package_ships_no_cars_names_paths_or_geometry(make_node):
    node = make_node()
    assert node.killable_nodes == []
    assert node.map_roots == []
    assert node.allowed_origins == set()
    assert node.laser_offset_x == 0.0
    assert node._string_list('tuning_nodes') == []
    assert node._string_list('tuning_config_files') == []
