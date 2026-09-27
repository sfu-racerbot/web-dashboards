"""The dashboard's car-side server (dashboard_node), port 8080.

    ros2 launch web_dashboard web_dashboard_launch.py car_config:=/path/to/your_car.yaml

config/web_dashboard.yaml (the package's generic defaults) is loaded
first; `car_config`, if given, is loaded on top of it, so a car's YAML
holds only the keys it changes. Without one the node starts, but no site is
allowed to connect (allowed_origins is unset) -- see car/README.md.

Support/tooling, not a control layer: publishes to no topic, so it is safe
to start alongside anything, at any time.
"""

import os

from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, OpaqueFunction
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node


def _dashboard(context):
    defaults = os.path.join(
        get_package_share_directory('web_dashboard'), 'config', 'web_dashboard.yaml')
    car_config = LaunchConfiguration('car_config').perform(context).strip()
    params = [defaults]
    if car_config:
        car_config = os.path.expanduser(car_config)
        if not os.path.isfile(car_config):
            raise RuntimeError(f'car_config: no such file: {car_config}')
        params.append(car_config)  # later files win
    return [Node(
        package='web_dashboard',
        executable='dashboard_node',
        name='web_dashboard_node',
        output='screen',
        parameters=params,
    )]


def generate_launch_description():
    return LaunchDescription([
        DeclareLaunchArgument(
            'car_config', default_value='',
            description="Your car's YAML, loaded on top of the package defaults "
                        '(only the keys it changes). Empty: defaults only.'),
        OpaqueFunction(function=_dashboard),
    ])
