#!/usr/bin/env bash
# Is everything the site needs running on this car? Read-only; safe any time.
#
#   car/check.sh
#
# Checks the three ports the tunnel routes point at, and the tunnel itself.
ok=0
check_port() {
  if ss -tln | awk '{print $4}' | grep -Eq "[:.]$1\$"; then
    echo "  ok    port $1  $2"
  else
    echo "  MISSING port $1  $2 -- nothing is listening"; ok=1
  fi
}
echo "services the tunnel routes point at:"
check_port 8080 "dashboard_node (Simple dashboard, relay and control)"
check_port 8765 "foxglove_bridge (Advanced dashboard)"
check_port 9090 "usb_cam_stream (camera)"
echo "tunnel:"
if systemctl is-active --quiet cloudflared; then
  echo "  ok    cloudflared service is running"
else
  echo "  MISSING cloudflared service is not running -- see car/README.md step 2"; ok=1
fi
exit $ok
