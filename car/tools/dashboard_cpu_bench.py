#!/usr/bin/env python3
"""Measure dashboard process CPU, separately from traffic and WebSocket readers.

Run through rb with this checkout's car/ros/web_dashboard first on PYTHONPATH.
CPU is percent of one core, not percent of the whole machine.
"""

import argparse
import asyncio
from array import array
from collections import Counter
import json
import os
from pathlib import Path
import platform
import signal
import socket
import subprocess
import sys
import tempfile
import time

import rclpy
from rclpy.node import Node
from rclpy.qos import QoSProfile, DurabilityPolicy
from ackermann_msgs.msg import AckermannDriveStamped
from geometry_msgs.msg import PoseStamped
from nav_msgs.msg import OccupancyGrid, Odometry
from sensor_msgs.msg import Joy, LaserScan
import tornado.httpclient
import tornado.websocket
import yaml


ROOT = Path(__file__).resolve().parents[2]
PACKAGE = ROOT / 'car/ros/web_dashboard'
ORIGIN = 'http://dashboard-bench.local'


def cpu_seconds(pid):
    # comm may contain spaces or parentheses; fields after its final ')' start at 3.
    fields = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
    return (int(fields[11]) + int(fields[12])) / os.sysconf('SC_CLK_TCK')


class Traffic(Node):
    def __init__(self, params):
        super().__init__('dashboard_cpu_bench')
        scan = LaserScan(angle_min=-2.35, angle_increment=4.7 / 1080,
                         range_min=0.05, range_max=30.0,
                         ranges=array('f', [2.0 + i / 1081 for i in range(1081)]))
        pose = PoseStamped()
        pose.pose.orientation.w = 1.0
        odom = Odometry()
        odom.twist.twist.linear.x = 1.5
        drive = AckermannDriveStamped()
        drive.drive.speed = 1.5
        joy = Joy(buttons=[0, 0, 0, 0, 1, 0])
        self.streams = []
        for cls, key, default, msg, hz in (
                (LaserScan, 'scan_topic', '/scan', scan, 40),
                (Odometry, 'odom_topic', '/odom', odom, 50),
                (AckermannDriveStamped, 'drive_topic', '/ackermann_cmd', drive, 40),
                (Joy, 'joy_topic', '/joy', joy, 20),
                (PoseStamped, 'pose_topics', ['/pf/viz/inferred_pose'], pose, 50)):
            topic = params.get(key, default)
            if isinstance(topic, list):
                topic = topic[0]
            self.streams.append((self.create_publisher(cls, topic, 10), msg, hz))
        self.map_pub = self.create_publisher(
            OccupancyGrid, params.get('map_topic', '/map'),
            QoSProfile(depth=1, durability=DurabilityPolicy.TRANSIENT_LOCAL))
        self.grid = OccupancyGrid()
        self.grid.info.width, self.grid.info.height = 420, 329
        self.grid.info.resolution = 0.05
        self.grid.info.origin.orientation.w = 1.0
        self.grid.data = array('b', [0] * (420 * 329))

    async def publish(self, pub, msg, hz):
        deadline = time.monotonic()
        while True:
            pub.publish(msg)
            deadline += 1.0 / hz
            await asyncio.sleep(max(0, deadline - time.monotonic()))

    async def maps(self):
        revision = 0
        while True:
            self.grid.data[revision % len(self.grid.data)] = 100
            self.map_pub.publish(self.grid)
            revision += 1
            await asyncio.sleep(5)


async def read_viewer(ws, counts):
    while True:
        frame = await ws.read_message()
        if frame is None:
            raise RuntimeError('viewer disconnected during measurement')
        if isinstance(frame, bytes):
            counts['binary'] += 1
        else:
            header = json.loads(frame)
            counts[header['type']] += 1
            if header['type'] == 'batch':
                counts.update(item['type'] for item in header['items'])


async def scenario(name, args, params, params_path):
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    env = dict(os.environ)
    env['PYTHONPATH'] = str(PACKAGE) + os.pathsep + env.get('PYTHONPATH', '')
    command = [sys.executable, '-m', 'web_dashboard.dashboard_node', '--ros-args',
               '--params-file', str(params_path), '-p', f'port:={port}',
               '-p', 'host:=127.0.0.1']
    tasks, viewers, counters = [], [], []
    traffic = None
    with tempfile.TemporaryFile(mode='w+') as log:
        process = subprocess.Popen(command, env=env, stdout=log, stderr=log)
        try:
            deadline = time.monotonic() + 15
            while True:
                if process.poll() is not None:
                    raise RuntimeError('dashboard exited before listening')
                try:
                    reader, writer = await asyncio.open_connection('127.0.0.1', port)
                    writer.close()
                    await writer.wait_closed()
                    break
                except OSError:
                    if time.monotonic() >= deadline:
                        raise RuntimeError('dashboard did not listen within 15 seconds')
                    await asyncio.sleep(0.1)
            if name != 'idle':
                traffic = Traffic(params)
                tasks.extend(asyncio.create_task(traffic.publish(*stream))
                             for stream in traffic.streams)
                tasks.append(asyncio.create_task(traffic.maps()))
                # Let DDS discovery complete before settling/measuring. Keeping
                # map updates away from window boundaries makes their counts repeatable.
                await asyncio.sleep(1)
            if name == 'watched':
                for _ in range(args.viewers):
                    ws = await tornado.websocket.websocket_connect(
                        tornado.httpclient.HTTPRequest(
                            f'ws://127.0.0.1:{port}/ws',
                            headers={'Origin': ORIGIN, 'X-Racerbot-Role': 'relay'}))
                    viewers.append(ws)
                    counts = Counter()
                    counters.append(counts)
                    tasks.append(asyncio.create_task(read_viewer(ws, counts)))
            await asyncio.sleep(args.settle)
            for counts in counters:
                counts.clear()
            start = time.monotonic()
            before = cpu_seconds(process.pid)
            await asyncio.sleep(args.duration)
            cpu = cpu_seconds(process.pid) - before
            elapsed = time.monotonic() - start
            if process.poll() is not None:
                raise RuntimeError('dashboard exited during measurement')
            for task in tasks:
                if task.done():
                    task.result()
            result = {'scenario': name, 'cpu_percent': round(100 * cpu / elapsed, 3),
                      'seconds': round(elapsed, 3),
                      'viewers': [{kind: round(count / elapsed, 3)
                                   for kind, count in sorted(counts.items())}
                                  for counts in counters]}
            print(json.dumps(result), flush=True)
            return result
        finally:
            for ws in viewers:
                ws.close()
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            if traffic:
                traffic.destroy_node()
            process.send_signal(signal.SIGINT)
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
            log.seek(0)
            print(log.read(), file=sys.stderr, end='')


async def run(args):
    if os.environ.get('ROS_DOMAIN_ID') != '79' or os.environ.get(
            'ROS_AUTOMATIC_DISCOVERY_RANGE') != 'LOCALHOST':
        raise RuntimeError('run through rb (isolated domain 79, LOCALHOST discovery)')
    params = yaml.safe_load(args.params.read_text())['web_dashboard_node']['ros__parameters']
    params['allowed_origins'] = [ORIGIN]
    print(json.dumps({'machine': platform.platform(), 'cores': os.cpu_count(),
                      'cpu': next((line.split(':', 1)[1].strip() for line in
                                   Path('/proc/cpuinfo').read_text().splitlines()
                                   if line.startswith('model name')), platform.machine()),
                      'params': str(args.params), 'settle': args.settle,
                      'duration': args.duration}), flush=True)
    with tempfile.TemporaryDirectory(prefix='dashboard-cpu-') as temporary:
        path = Path(temporary) / 'params.yaml'
        path.write_text(yaml.safe_dump({'web_dashboard_node': {'ros__parameters': params}}))
        rclpy.init()
        try:
            for name in args.scenarios:
                await scenario(name, args, params, path)
        finally:
            rclpy.shutdown()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--params', type=Path,
                        default=PACKAGE / 'config/web_dashboard.yaml')
    parser.add_argument('--viewers', type=int, default=1)
    parser.add_argument('--settle', type=float, default=10)
    parser.add_argument('--duration', type=float, default=30)
    parser.add_argument('--scenarios', nargs='+', choices=['idle', 'traffic', 'watched'],
                        default=['idle', 'traffic', 'watched'])
    options = parser.parse_args()
    if options.viewers < 1 or options.settle < 0 or options.duration <= 0:
        parser.error('viewers and duration must be positive; settle must be nonnegative')
    asyncio.run(run(options))
