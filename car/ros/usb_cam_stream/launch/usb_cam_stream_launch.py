"""The camera's MJPEG stream (camera_stream_node), port 9090.

    ros2 launch usb_cam_stream usb_cam_stream_launch.py car_config:=/path/to/your_car.yaml

config/usb_cam_stream.yaml (generic defaults: a UVC webcam on /dev/video0)
is loaded first; `car_config`, if given, is loaded on top of it. To stream
a camera that already has a ROS driver (a RealSense, say) set `image_topic`
there instead of `device` -- see car/docs/usb-camera-livestream.md.

Support/tooling: publishes to no topic, safe to start alongside anything.
"""

import os

from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, OpaqueFunction
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node


def _camera(context):
    defaults = os.path.join(
        get_package_share_directory('usb_cam_stream'), 'config', 'usb_cam_stream.yaml')
    car_config = LaunchConfiguration('car_config').perform(context).strip()
    params = [defaults]
    if car_config:
        car_config = os.path.expanduser(car_config)
        if not os.path.isfile(car_config):
            raise RuntimeError(f'car_config: no such file: {car_config}')
        params.append(car_config)  # later files win
    return [Node(
        package='usb_cam_stream',
        executable='camera_stream_node',
        name='usb_cam_stream_node',
        output='screen',
        parameters=params,
    )]


def generate_launch_description():
    return LaunchDescription([
        DeclareLaunchArgument(
            'car_config', default_value='',
            description="Your car's YAML, loaded on top of the package defaults "
                        '(only the keys it changes). Empty: defaults only.'),
        OpaqueFunction(function=_camera),
    ])
