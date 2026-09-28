#!/usr/bin/env bash
# Run every car-side Python test that needs NO ROS, by name -- what CI runs,
# and what you can run on a laptop with no ROS installed.
#
#   car/ros/run_ros_free_tests.sh            # from the repo root
#
# Needs: python3 with pytest, tornado, psutil, numpy, pyyaml, setuptools; and the
# drive_intent package importable (PYTHONPATH) for the two intent files --
# it belongs to the car workspace, see car/README.md "Running the tests".
#
# Which runner runs which test file (car/README.md, "Running the tests"):
#   ROS_FREE   here, in CI, and under colcon on a car
#   ROS_ONLY   colcon on a car ONLY: they import rclpy/cv2. Run them on an
#              isolated ROS domain (ROS_DOMAIN_ID=79
#              ROS_AUTOMATIC_DISCOVERY_RANGE=LOCALHOST) -- they join the graph.
#
# Every test file must be in exactly one list: a new file in neither fails
# this script, so it cannot silently go unrun.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

ROS_FREE=(
  web_dashboard/test/test_batching.py
  web_dashboard/test/test_foxglove_bridge_config.py
  web_dashboard/test/test_install_files.py
  web_dashboard/test/test_intent_optional.py
  web_dashboard/test/test_intent_protocol.py
  web_dashboard/test/test_map_protocol.py
  web_dashboard/test/test_mapstore.py
  web_dashboard/test/test_mapstream.py
  web_dashboard/test/test_netbind.py
  web_dashboard/test/test_origins.py
  web_dashboard/test/test_proccontrol.py
  web_dashboard/test/test_protocol.py
  web_dashboard/test/test_protocol_encoding.py
  web_dashboard/test/test_racing_line_protocol.py
  web_dashboard/test/test_remote_check.py
  web_dashboard/test/test_roles.py
  web_dashboard/test/test_server.py
  web_dashboard/test/test_stopwatch.py
  web_dashboard/test/test_tuning.py
)
ROS_ONLY=(
  web_dashboard/test/test_dashboard_node_defaults.py
  usb_cam_stream/test/test_camera_stream_node.py
  usb_cam_stream/test/test_stream_tiers.py
)

listed=$(printf '%s\n' "${ROS_FREE[@]}" "${ROS_ONLY[@]}" | sort)
on_disk=$(ls web_dashboard/test/test_*.py usb_cam_stream/test/test_*.py | sort)
if [ "$listed" != "$on_disk" ]; then
  echo "test files on disk and in this script's two lists differ:" >&2
  diff <(echo "$listed") <(echo "$on_disk") >&2 || true
  exit 1
fi

# From the package directory, as colcon runs them: the tests import
# web_dashboard from there.
cd web_dashboard
exec python3 -m pytest -v -p no:cacheprovider "${ROS_FREE[@]#web_dashboard/}" "$@"
