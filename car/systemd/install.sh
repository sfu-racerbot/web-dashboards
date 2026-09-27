#!/usr/bin/env bash
# Start foxglove_bridge at boot -- the ONLY service this repo installs.
#
#   sudo car/systemd/install.sh <user> <workspace>
#   e.g. sudo car/systemd/install.sh racerbot /home/racerbot/racerbot-ws
#
# <user> runs the service (the account that owns the ROS 2 workspace);
# <workspace> is the colcon workspace that has web_dashboard built into it.
#
# Installs /etc/systemd/system/foxglove-bridge.service, pointing at
# foxglove-bridge.sh in THIS folder (so keep this checkout where it is),
# enables it, and (re)starts it so a changed unit takes effect now.
#
# dashboard_node and the camera are NOT installed as services: you start
# them by hand when you want them (car/README.md). Earlier versions of this
# script installed racerbot-dashboard, racerbot-camera and
# racerbot-foxglove-bridge; see car/README.md for removing those.
#
# The bridge cannot move the car: browsers can publish to no topic at all
# (config/foxglove_bridge.yaml in web_dashboard, and its test).
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
if [ ! -d "$workspace/install/web_dashboard" ]; then
  echo "$workspace/install/web_dashboard not found -- web_dashboard is not built in that workspace" >&2
  exit 1
fi
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

sed -e "s|@USER@|$user|g" -e "s|@WORKSPACE@|$workspace|g" -e "s|@HERE@|$here|g" \
  "$here/foxglove-bridge.service" > /etc/systemd/system/foxglove-bridge.service
systemctl daemon-reload
systemctl enable foxglove-bridge
systemctl restart foxglove-bridge
systemctl --no-pager --lines=5 status foxglove-bridge || true
