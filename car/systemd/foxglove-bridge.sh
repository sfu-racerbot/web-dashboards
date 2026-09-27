#!/bin/bash
# Start foxglove_bridge the way foxglove-bridge.service needs: a login
# shell's ROS environment, rebuilt from scratch, because systemd starts
# services with an almost empty environment.
#
# RACERBOT_WS is the colcon workspace that has web_dashboard built into it;
# the unit sets it (install.sh fills it in). Defaults to ~/racerbot-ws.
#
# ROS_DOMAIN_ID and RMW_IMPLEMENTATION are deliberately NOT set here. SFU
# Racerbot car 2's stack runs with both unset (checked 2026-09-26: not in
# ~/.bashrc, ~/.profile or /etc/environment), which means domain 0 and Fast
# DDS (rmw_fastrtps_cpp). A bridge on a different domain would start fine
# and show an empty topic list. If your stack sets either, put the same
# values in /etc/default/foxglove-bridge (see the unit file) -- never only
# here.
#
# See car/docs/foxglove-bridge.md.

# No `set -u`: ROS's setup.bash reads unset variables on purpose.
set -e

WORKSPACE="${RACERBOT_WS:-$HOME/racerbot-ws}"

# shellcheck disable=SC1091
source /opt/ros/jazzy/setup.bash
# shellcheck disable=SC1091
source "${WORKSPACE}/install/setup.bash"

exec ros2 launch web_dashboard foxglove_bridge_launch.py
