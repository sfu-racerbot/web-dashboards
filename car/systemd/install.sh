#!/usr/bin/env bash
# Start the car's three web-facing services at boot, as systemd services.
#
#   sudo car/systemd/install.sh <user> <workspace>
#   e.g. sudo car/systemd/install.sh racerbot /home/racerbot/racerbot-ws
#
# <user> runs the services (the account that owns the ROS 2 workspace);
# <workspace> is the colcon workspace that contains web_dashboard and
# usb_cam_stream, already built.
#
# Installs, enables and starts:
#   racerbot-dashboard        ros2 launch web_dashboard web_dashboard_launch.py  (port 8080)
#   racerbot-camera           ros2 launch usb_cam_stream usb_cam_stream_launch.py (port 9090)
#   racerbot-foxglove-bridge  foxglove_bridge on localhost:8765
#
# None of these publishes a drive command, so none of them can move the car:
# the car repo documents web_dashboard and usb_cam_stream as safe to leave
# running at all times, and the bridge lets a browser publish to no topic at all.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then echo "run with sudo" >&2; exit 1; fi
user="${1:-}"; workspace="${2:-}"
if [ -z "$user" ] || [ -z "$workspace" ]; then
  echo "usage: sudo $0 <user> <workspace>" >&2; exit 1
fi
if [ ! -f "$workspace/install/setup.bash" ]; then
  echo "$workspace/install/setup.bash not found -- build the workspace first (colcon build --symlink-install)" >&2
  exit 1
fi
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

install -d -m 0755 /etc/racerbot
install -m 0644 "$here/../foxglove_bridge/racerbot_foxglove_bridge_launch.xml" /etc/racerbot/

for unit in racerbot-dashboard racerbot-camera racerbot-foxglove-bridge; do
  sed -e "s|@USER@|$user|g" -e "s|@WORKSPACE@|$workspace|g" "$here/$unit.service" > "/etc/systemd/system/$unit.service"
done
systemctl daemon-reload
systemctl enable --now racerbot-dashboard racerbot-camera racerbot-foxglove-bridge
systemctl --no-pager --lines=3 status racerbot-dashboard racerbot-camera racerbot-foxglove-bridge || true
