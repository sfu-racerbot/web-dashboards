#!/usr/bin/env bash
# Is everything the site needs running on this car? Read-only; safe any time.
#
#   car/check.sh
#
# Checks the three ports the tunnel routes point at, and the tunnel itself.
# Only foxglove_bridge starts at boot; the dashboard and the camera are
# started by hand, so MISSING on 8080 or 9090 just means "not started yet".
# For a deeper, hop-by-hop check run
#   ros2 run web_dashboard remote_check --site https://<your site> --car <car id>
ok=0
check_port() {
  if ss -tln | awk '{print $4}' | grep -Eq "[:.]$1\$"; then
    echo "  ok      port $1  $2"
  else
    echo "  MISSING port $1  $2 -- nothing is listening. $3"; ok=1
  fi
}
echo "services the tunnel routes point at:"
check_port 8080 "dashboard_node (Simple dashboard, relay and control)" \
  "Start it: ros2 launch web_dashboard web_dashboard_launch.py car_config:=<your YAML>"
check_port 8765 "foxglove_bridge (Advanced dashboard)" \
  "It runs at boot: sudo systemctl status foxglove-bridge"
check_port 9090 "usb_cam_stream (camera)" \
  "Start it: ros2 launch usb_cam_stream usb_cam_stream_launch.py car_config:=<your YAML>"
echo "tunnel:"
if systemctl is-active --quiet cloudflared; then
  echo "  ok      cloudflared service is running"
else
  echo "  MISSING cloudflared service is not running -- see car/README.md, the tunnel step"; ok=1
fi
exit $ok
