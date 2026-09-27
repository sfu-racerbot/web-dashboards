#!/usr/bin/env bash
# Install cloudflared on the car and run the car's tunnel as a system service.
#
#   sudo car/cloudflared/install.sh <TUNNEL_TOKEN>
#
# The token comes from the Cloudflare dashboard (Networking > Tunnels >
# your tunnel > the install command shows it after "service install").
# It is a secret: paste it here, never commit it.
#
# Follows Cloudflare's own Debian/Ubuntu steps (pkg.cloudflare.com). Works on
# the Jetson's Ubuntu 24.04 (arm64) and on any amd64 Ubuntu/Debian.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "run with sudo: sudo $0 <TUNNEL_TOKEN>" >&2
  exit 1
fi
token="${1:-}"
if [ -z "$token" ]; then
  echo "usage: sudo $0 <TUNNEL_TOKEN>" >&2
  exit 1
fi

mkdir -p --mode=0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" \
  > /etc/apt/sources.list.d/cloudflared.list
apt-get update
apt-get install -y cloudflared

# Replaces any earlier install, so re-running with a new token is safe.
cloudflared service uninstall >/dev/null 2>&1 || true
cloudflared service install "$token"

systemctl --no-pager --lines=0 status cloudflared || true
echo
echo "cloudflared installed and running. In the dashboard, the tunnel should show HEALTHY within a minute."
