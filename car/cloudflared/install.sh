#!/usr/bin/env bash
# Install cloudflared on the car and run the car's tunnel as a system service.
#
#   sudo car/cloudflared/install.sh              # asks for the token (not echoed)
#   sudo car/cloudflared/install.sh --migrate    # fix an earlier install, see below
#
# The token comes from the Cloudflare dashboard (Networking > Tunnels >
# your tunnel > the install command shows it after "service install").
# It is a secret: paste it at the prompt, never commit it.
#
# Where the token goes. Cloudflare's own `cloudflared service install <token>`
# writes it onto the unit's ExecStart line, so any user on the car can read
# it with `ps` or `systemctl cat cloudflared`, and passing it to this script
# as an argument would leave it in shell history too. Instead this script
# writes it to /etc/cloudflared/tunnel.env (root only, 0600) and writes the
# unit itself, loading the token with EnvironmentFile= (cloudflared reads
# TUNNEL_TOKEN). The unit is otherwise the one Cloudflare generates.
#
# --migrate moves the token out of an existing unit installed the old way
# (by earlier versions of this script, or `cloudflared service install`),
# without asking for it again or reinstalling the package.
#
# Follows Cloudflare's own Debian/Ubuntu steps (pkg.cloudflare.com). Works on
# the Jetson's Ubuntu 24.04 (arm64) and on any amd64 Ubuntu/Debian.
set -euo pipefail

UNIT=/etc/systemd/system/cloudflared.service
ENV_DIR=/etc/cloudflared
ENV_FILE=$ENV_DIR/tunnel.env

if [ "$(id -u)" -ne 0 ]; then
  echo "run with sudo: sudo $0" >&2
  exit 1
fi

mode=install
case "${1:-}" in
  "") ;;
  --migrate) mode=migrate ;;
  *)
    echo "pass no token on the command line -- it would stay in your shell history." >&2
    echo "usage: sudo $0            (asks for the token)" >&2
    echo "       sudo $0 --migrate  (moves the token out of an existing unit)" >&2
    exit 1 ;;
esac

if [ "$mode" = migrate ]; then
  if [ ! -f "$UNIT" ]; then
    echo "$UNIT not found -- nothing to migrate; run without --migrate" >&2; exit 1
  fi
  token=$(sed -n 's/^ExecStart=.*--token[ =]\([A-Za-z0-9+\/=_-]*\).*/\1/p' "$UNIT" | head -1)
  if [ -z "$token" ]; then
    if grep -q '^EnvironmentFile=.*tunnel\.env' "$UNIT"; then
      echo "already migrated: $UNIT loads $ENV_FILE"; exit 0
    fi
    echo "no --token on the ExecStart line of $UNIT -- not an install this script knows" >&2; exit 1
  fi
else
  if [ -t 0 ]; then
    read -r -s -p "Tunnel token (not shown): " token; echo
  else
    read -r token
  fi
fi

# Base64url, about 180 characters for Cloudflare's tunnel tokens.
if ! [[ "$token" =~ ^[A-Za-z0-9+/=_-]{50,}$ ]]; then
  echo "that doesn't look like a tunnel token (a long base64 string, no spaces)" >&2; exit 1
fi

if [ "$mode" = install ]; then
  mkdir -p --mode=0755 /usr/share/keyrings
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
  echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" \
    > /etc/apt/sources.list.d/cloudflared.list
  apt-get update
  apt-get install -y cloudflared
fi

install -d -m 0700 -o root -g root "$ENV_DIR"
# Created 0600 before the token goes in, so it is never readable by others.
install -m 0600 -o root -g root /dev/null "$ENV_FILE"
printf 'TUNNEL_TOKEN=%s\n' "$token" > "$ENV_FILE"
unset token

# Replaces any earlier unit, so re-running with a new token is safe.
cat > "$UNIT" <<EOF
[Unit]
Description=cloudflared
After=network-online.target
Wants=network-online.target

[Service]
# The tunnel token, root-only (car/cloudflared/install.sh).
EnvironmentFile=$ENV_FILE
TimeoutStartSec=15
Type=notify
ExecStart=$(command -v cloudflared) --no-autoupdate tunnel run
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
EOF
chmod 0644 "$UNIT"

systemctl daemon-reload
systemctl enable cloudflared
systemctl restart cloudflared
systemctl --no-pager --lines=0 status cloudflared || true
echo
if ps -o args= -C cloudflared | grep -q -- '--token'; then
  echo "WARNING: a cloudflared process still has --token on its command line" >&2
fi
echo "cloudflared installed and running; its token is in $ENV_FILE (root only)."
echo "In the dashboard, the tunnel should show HEALTHY within a minute."
