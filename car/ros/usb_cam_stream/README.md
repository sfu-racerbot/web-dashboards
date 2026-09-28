# `usb_cam_stream`

> **Who this is for:** someone reading or changing this package's code.
> **Read first:** [car/docs/usb-camera-livestream.md](../../docs/usb-camera-livestream.md) for setup and the security note.
> **What's in it:** how the MJPEG server works and what it exposes.

Serves a camera as a live MJPEG video stream over plain HTTP — the
site's camera inset, or `http://<car-ip>:9090/` in any browser on the
car's network, no ROS install or plugins needed on the viewing device. Two
frame sources, one node: a USB webcam captured directly over V4L2 (the
default), or any `sensor_msgs/Image` ROS topic (`image_topic` mode — for a
camera whose device is held by its own ROS driver, like a RealSense). Full
write-up (camera recommendations, wire format, security, parameter
reference):
[car/docs/usb-camera-livestream.md](../../docs/usb-camera-livestream.md).

## Files

| File | What it is |
|---|---|
| [`usb_cam_stream/camera_stream_node.py`](usb_cam_stream/camera_stream_node.py) | The node: frame source (OpenCV/V4L2 capture thread, or an image-topic subscription) + a Tornado web server serving the MJPEG stream. Small enough to keep in one file, same as `gap_follow`. |
| [`config/usb_cam_stream.yaml`](config/usb_cam_stream.yaml) | Generic defaults (a UVC webcam on `/dev/video0`): device path, resolution, FPS, JPEG quality, host/port. A car changes behaviour in its own YAML, not here and not in the code. |
| [`launch/usb_cam_stream_launch.py`](launch/usb_cam_stream_launch.py) | Starts the node with the defaults, plus `car_config:=<your YAML>` on top. |
| [`web/index.html`](web/index.html) | The entire browser side — a single `<img src="/stream">` tag, no JS needed. |
| `resource/usb_cam_stream` | Empty marker file required by `ament_python` — not code. |

## Interface

- **Publishes:** nothing, in either mode.
- **Subscribes:** nothing in the default V4L2 mode (talks to the camera
  directly, no ROS topics at all); only the configured `image_topic`
  (`sensor_msgs/Image`) in topic mode. Either way it never touches
  `/drive` or anything another node reads, so it's safe to run alongside
  any other node, at any time.

## Running it

**Terminal 1, on the car:**

```bash
source /opt/ros/jazzy/setup.bash && source ~/racerbot-ws/install/setup.bash
ros2 launch usb_cam_stream usb_cam_stream_launch.py car_config:=/path/to/your_car.yaml
```

**Working when:** the site's camera inset fills in, or `http://<car-ip>:9090/`
shows the picture (port `9090`, not `8080` — that's `web_dashboard`'s).
SFU Racerbot car 2 starts its RealSense and this stream together with
`ros2 launch racerbot_launch realsense_camera_launch.py`.

**Tests:** the stream's decisions (which tier a request gets, preview
sizing, spotting the camera's own JPEG, the status states and log
throttling) live in `usb_cam_stream/stream_logic.py`, which imports neither
ROS nor OpenCV; `test/test_stream_logic.py` covers it and runs anywhere,
CI included. The other two files in `test/` import `rclpy` and `cv2`, so
they run under colcon on a car (on an isolated ROS domain) — see
[car/README.md](../../README.md#running-the-tests).

The launch terminal reports the exact camera state: waiting for a device or
image topic, negotiated V4L2 mode, first-frame recovery, healthy frame count/
age/JPEG size, stale input, lost camera, conversion failure, and JPEG encoding
failure. State changes print immediately; healthy or unchanged faults repeat
every `status_log_period_sec` (default `5.0` s). `frame_timeout_sec` (default
`2.0` s) sets the stale-frame threshold; use a log period of `0.0` for changes
only.
