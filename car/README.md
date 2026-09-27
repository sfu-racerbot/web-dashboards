# Setting up a car

> **Who this is for:** anyone setting up a car, the team's or your own, so it shows up on the dashboards site. Linux command-line basics assumed; no Cloudflare experience needed.
> **Read first:** the [top-level README](../README.md) (what the site is), and the car workspace's own [README](https://github.com/sfu-racerbot/Racerbot-Car-2-Workspace) (building ROS 2 on the car).
> **You'll be able to:** install and start everything the car needs, so its dashboards open from anywhere at `https://dashboard.sfuracerbot.ca`, or at your own copy of the site.
> **Time:** about 30 minutes on a car that already has the ROS 2 workspace built.

The car runs three small servers and one tunnel. That is all. It never talks to the internet directly: it opens an outbound connection to Cloudflare (the **tunnel**), and Cloudflare sends it only the requests the site makes.

## What runs on the car

| Program | Port | What it is for | Comes from |
|---|---|---|---|
| `dashboard_node` | 8080 | The simple dashboard's data: map, LiDAR, pose, tuning, processes, saved maps | the car workspace's `web_dashboard` package |
| `usb_cam_stream` | 9090 | The camera, as an MJPEG video stream | the car workspace's `usb_cam_stream` package |
| `foxglove_bridge` | 8765 | The advanced dashboard (Lichtblick): every ROS 2 topic, service and parameter | `apt`, configured by [`foxglove_bridge/`](foxglove_bridge/) here |
| `cloudflared` | none | The tunnel: carries the site's requests to the three ports above | `apt`, installed by [`cloudflared/install.sh`](cloudflared/install.sh) here |

A **tunnel** is a program on the car that keeps an outgoing connection open to Cloudflare. Requests for the car's three hostnames (`rb2-dash-origin.sfuracerbot.ca` and so on) travel down it to `localhost:8080`, `:8765` and `:9090`. No port is opened on the car's router or firewall.

## What is in this folder

| Path | What it is |
|---|---|
| [`cloudflared/install.sh`](cloudflared/install.sh) | Installs `cloudflared` from Cloudflare's package repository and runs the car's tunnel as a service |
| [`foxglove_bridge/racerbot_foxglove_bridge_launch.xml`](foxglove_bridge/racerbot_foxglove_bridge_launch.xml) | Launches the bridge the way the site expects: localhost only, port 8765, no Foxglove cloud, and browsers may publish to `/initialpose` only |
| [`systemd/`](systemd/) | Three services and an installer, so the three servers start at boot |
| [`check.sh`](check.sh) | Says whether everything is running. Read-only; run it any time |

## Before you start

- [ ] The car runs **Ubuntu 24.04 with ROS 2 Jazzy**. The team's car is a Jetson Orin Nano Super; any Jazzy machine works.
- [ ] The car workspace is cloned and built. It supplies `web_dashboard` and `usb_cam_stream`. Follow its README's quick start, which ends with `colcon build --symlink-install`.
- [ ] This repo is cloned on the car (`git clone https://github.com/sfu-racerbot/web-dashboards`), for the files in this folder.
- [ ] Someone with access to the Cloudflare account can do steps 3 and 4 in the dashboard, or already has.

## 1. Install foxglove_bridge

**Terminal 1**, on the car:

```bash
sudo apt update
sudo apt install ros-jazzy-foxglove-bridge
```

**Working when:** `ros2 pkg prefix foxglove_bridge` (after `source /opt/ros/jazzy/setup.bash`) prints a path instead of `Package not found`.

## 2. Try the three servers by hand

Before making anything start at boot, check each one runs. Three terminals on the car. In each, first:

```bash
source /opt/ros/jazzy/setup.bash && source ~/racerbot-ws/install/setup.bash
```

**Terminal 1** — the dashboard's server:

```bash
ros2 launch web_dashboard web_dashboard_launch.py
```

**Working when:** the log says it is serving on port 8080.

**Terminal 2** — the camera. With the RealSense instead of a USB webcam, use `ros2 launch racerbot_launch realsense_camera_launch.py`.

```bash
ros2 launch usb_cam_stream usb_cam_stream_launch.py
```

**Working when:** the log says the stream is on port 9090. With no camera plugged in it keeps running and reports "camera offline"; that is fine.

**Terminal 3** — the bridge, from where you cloned this repo:

```bash
ros2 launch ~/web-dashboards/car/foxglove_bridge/racerbot_foxglove_bridge_launch.xml
```

**Working when:** the log shows the bridge listening on `127.0.0.1:8765`.

**Terminal 4** — check all three:

```bash
~/web-dashboards/car/check.sh
```

**Working when:** the three port lines say `ok`. The `cloudflared` line says `MISSING` until step 3.

Stop the three with `Ctrl+C` before step 5 starts them as services.

## 3. Create the car's tunnel and install cloudflared

**👤 In the Cloudflare dashboard:**

1. Go to **Networking** > **Tunnels** and select **Create a tunnel**. Choose **Cloudflared**.
2. Name it after the car, for example `rb2`, and select **Create Tunnel**.
3. For the operating system choose **Debian**, and your car's architecture (**arm64** for a Jetson).
4. Of the commands the page shows, copy only the **token**: the long string after `cloudflared service install`. Treat it like a password.

**Terminal 1**, on the car:

```bash
sudo ~/web-dashboards/car/cloudflared/install.sh <paste-the-token>
```

**Working when:** the script ends with `cloudflared installed and running`, and within a minute the dashboard shows the tunnel as **Healthy**. Select **Continue** there.

## 4. Point the car's hostnames at the three ports

**👤 In the Cloudflare dashboard.** Do the origin Access application first (step 2 of [cloudflare-setup.md](../docs/cloudflare-setup.md)), so these hostnames are never open. Then step 4 of the same doc adds the three routes:

| Hostname | Service |
|---|---|
| `rb2-dash-origin.sfuracerbot.ca` | `http://localhost:8080` |
| `rb2-bridge-origin.sfuracerbot.ca` | `http://localhost:8765` |
| `rb2-cam-origin.sfuracerbot.ca` | `http://localhost:9090` |

For another car, replace `rb2` everywhere with its id, and add it to `CARS` in [`wrangler.jsonc`](../wrangler.jsonc) ([how](../docs/cloudflare-setup.md#adding-a-car)).

## 5. Start everything at boot

**Terminal 1**, on the car, with your user name and workspace path:

```bash
sudo ~/web-dashboards/car/systemd/install.sh racerbot /home/racerbot/racerbot-ws
```

**Working when:** it prints three services as `active (running)`, and `~/web-dashboards/car/check.sh` says `ok` on every line.

To see a service's log: `journalctl -u racerbot-dashboard -f` (or `racerbot-camera`, `racerbot-foxglove-bridge`). To stop one: `sudo systemctl stop racerbot-camera`. To stop it starting at boot: `sudo systemctl disable racerbot-camera`.

**Using the RealSense camera** instead of a webcam: edit `/etc/systemd/system/racerbot-camera.service`, change the launch command to `ros2 launch racerbot_launch realsense_camera_launch.py`, then `sudo systemctl daemon-reload && sudo systemctl restart racerbot-camera`.

## 6. Check it from anywhere

Open https://dashboard.sfuracerbot.ca, log in, and open **Simple** for the car.

**Working when:** the row under `CONNECTED` reads `CAR ONLINE · 1 WATCHING` and the map, LiDAR and camera appear.

## Safety

**Nothing installed here can move the car.**

`dashboard_node` and `usb_cam_stream` publish to no drive topic; the car workspace documents both as safe to leave running during a race. Starting them at boot changes nothing about how the car drives.

**The bridge lets a browser publish to `/initialpose` and nothing else.** Do not widen `client_topic_whitelist` to a drive topic.

The car workspace's rule is that anything publishing to `/drive` or `/ackermann_cmd` must implement the LB deadman: let go of the gamepad's LB button and the car stops. A browser tab cannot do that. So a topic Lichtblick could publish to must never be one that moves the car.

**Lichtblick can still set parameters and call services** without the simple dashboard's arming step. Each driving node enforces its own parameter bounds, and `enable_deadman` cannot be changed at runtime. But a service call like `/slam_toolbox/reset` goes through with no "is anything driving?" check. For a watch-only Advanced, set `capabilities` in the bridge launch file as its comment says.

**On the car's own WiFi, port 8080 needs no login.** `dashboard_node` listens on every interface (`host: 0.0.0.0` in `web_dashboard.yaml`), as it always has, so anyone on the same network can open `http://<car-ip>:8080`. To make the website the only way in, set `host: 127.0.0.1` there. The tunnel only needs localhost.

## Which car software version the site needs

The site works with the car workspace as it is today.

The site and the car have a small agreement, the **car contract**: the car's first message is a `hello` naming its protocol version, and it treats the site's shared `relay` connection and each person's `control` connection differently. It is written out in [docs/decisions.md](../docs/decisions.md#the-car-contract-as-built). A car that has not implemented it yet counts as **protocol version 0**, which the site accepts:

| | Car without the contract (v0) | Car with it (v1) |
|---|---|---|
| Watching, relay, late joiners | works | works |
| Tuning, stop, delete, SLAM reset | work | work |
| The control link also receives the full telemetry stream | yes, doubling that tab's traffic while it is open | no |
| The car refuses writes on the shared relay link | no — but the site never sends any there | yes |
| The car knows which person made a change (`X-Racerbot-User`) | ignored | logged |
| Protocol-mismatch banner if the car and site disagree | never shown | shown on a real mismatch |

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `check.sh`: a port is `MISSING` | that service is not running | `journalctl -u racerbot-<name> -n 50` shows why. A workspace not built, or the wrong path given to `install.sh`, are the usual reasons |
| Tunnel shows **Down** in the dashboard | `cloudflared` stopped, or the car has no internet | `sudo systemctl status cloudflared`; `sudo systemctl restart cloudflared` |
| Simple says `CAR OFFLINE`, everything above is fine | the relay cannot get through | Hover the row for the relay's reason. `HTTP 401/403` means the service token or the origin Access app (setup doc steps 1, 2 and 6); `HTTP 502/530` means the tunnel route or `dashboard_node` |
| Camera inset says "camera offline" | `racerbot-camera` not running, or no camera plugged in | `journalctl -u racerbot-camera -n 50` |
| Advanced cannot connect | the bridge is not running, or the `rb2-bridge-origin` route is missing | `check.sh`, then setup doc step 4 |
