"""foxglove_bridge for Lichtblick (the site's Advanced dashboard).

    ros2 launch web_dashboard foxglove_bridge_launch.py

At boot it is started by car/systemd/foxglove-bridge.service in
web-dashboards -- the only thing in that repo that runs at boot.

Support/tooling, not a control layer: start it alongside anything, in its
own terminal, like the web dashboard. It listens on 127.0.0.1:8765 only
and is reached from off the car through the Cloudflare Tunnel.

It is NOT read-only the way the dashboard is. Clients can set parameters
and call services on every node. They cannot publish to ANY topic: the
clientPublish capability is off, because foxglove_bridge 3.5.0 does not
enforce client_topic_whitelist and a raw /drive publish would skip every
driving node's LB deadman (measured 2026-09-27). Read
car/docs/foxglove-bridge.md before changing config/foxglove_bridge.yaml.
"""

import os

from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node


def generate_launch_description():
    default_params = os.path.join(
        get_package_share_directory('web_dashboard'), 'config', 'foxglove_bridge.yaml')
    return LaunchDescription([
        DeclareLaunchArgument(
            'params_file', default_value=default_params,
            description='foxglove_bridge parameter file. The default turns client '
                        'publishing off entirely -- see '
                        'car/docs/foxglove-bridge.md (web-dashboards) before pointing this elsewhere.'),
        Node(
            package='foxglove_bridge',
            executable='foxglove_bridge',
            name='foxglove_bridge',
            output='screen',
            parameters=[LaunchConfiguration('params_file')],
        ),
    ])
