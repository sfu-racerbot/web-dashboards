# Setting up Car 1 (`rb1`)

> **Who this is for:** whoever brings Car 1 onto https://dashboard.sfuracerbot.ca.
> **Read first:** nothing. This page is a checklist that points into [car/README.md](../car/README.md) (the full car guide) and [cloudflare-setup.md](cloudflare-setup.md) (the Cloudflare clicks) with Car 1's names filled in.
> **What's in it:** what is already done, what to do in Cloudflare, what to do on the car, and how to know it works.

## What is already done

The site already knows Car 1. `rb1` is in `CARS` in [`wrangler.jsonc`](../wrangler.jsonc), so the landing page shows a **Car 1** card and these addresses exist:

| Address | What it is |
|---|---|
| `https://dashboard.sfuracerbot.ca/rb1/simple/` | Simple dashboard |
| `https://dashboard.sfuracerbot.ca/rb1/advanced/` | Advanced (Lichtblick), via the landing page's button |
| `https://dashboard.sfuracerbot.ca/rb1/simple/camera.html` | Camera on its own |
| `https://dashboard.sfuracerbot.ca/rb1/check` | Tests every hop from the site to Car 1 |

Until the steps below are done, the card says `Idle · nobody watching`, and opening a dashboard turns it red (`Offline`) with the reason. That is expected.

**Nothing changes in the Worker's settings.** Car 1 uses the same service token (`ACCESS_CLIENT_ID`, `ACCESS_CLIENT_SECRET`) and the same team email list as Car 2. The WAF rule's `-origin.sfuracerbot.ca` exception already covers Car 1's hostnames.

## Car 1's names

| Thing | Value |
|---|---|
| Car id | `rb1` |
| Tunnel name | `rb1` |
| Dashboard hostname → port | `rb1-dash-origin.sfuracerbot.ca` → `http://localhost:8080` |
| Bridge hostname → port | `rb1-bridge-origin.sfuracerbot.ca` → `http://localhost:8765` |
| Camera hostname → port | `rb1-cam-origin.sfuracerbot.ca` → `http://localhost:9090` |
| Access application | `rb1 origins` |

## Order

Do it in this order, so Car 1's hostnames are never open to the internet, not even briefly:

1. [Lock the hostnames](#1-lock-car-1s-hostnames---dashboard) (Cloudflare)
2. [Bring Car 1's software up to date](#2-bring-car-1s-software-up-to-date--on-the-car) (car)
3. [Try the three servers by hand](#3-try-the-three-servers-by-hand--on-the-car) (car)
4. [Create the tunnel and install cloudflared](#4-create-the-tunnel-and-install-cloudflared---dashboard--on-the-car) (Cloudflare and car)
5. [Add the three routes](#5-add-the-three-routes---dashboard) (Cloudflare)
6. [Start the bridge at boot](#6-start-the-bridge-at-boot--on-the-car) (car)
7. [Check every hop](#7-check-every-hop) (car and browser)

## 1. Lock Car 1's hostnames — 👤 Dashboard

[cloudflare-setup.md step 2](cloudflare-setup.md#2-lock-the-cars-three-origin-hostnames-to-that-token---dashboard), with Car 1's names:

1. **Zero Trust** > **Access controls** > **Applications** > **Create new application** > **Self-hosted and private**.
2. Name it `rb1 origins`. **Add public hostname** three times: `rb1-dash-origin`, `rb1-bridge-origin`, `rb1-cam-origin`, each on `sfuracerbot.ca`.
3. **Access policies:** one policy, `worker only`, **Action: Service Auth**, **Include: Service Token** = `racerbot-dashboard-worker` (the token Car 2 already uses). No other policy.
4. **Additional settings:** turn on **401 Response for Service Auth policies**.
5. **Create**.

**Working when:** the application lists the three `rb1-…` hostnames and exactly one policy, with action Service Auth.

Use a new application rather than adding the hostnames to `rb2 origins`, so either car can be removed on its own later.

## 2. Bring Car 1's software up to date — on the car

Car 1's workspace ([Racerbot-Car-1-Workspace](https://github.com/sfu-racerbot/Racerbot-Car-1-Workspace)) has an **older** `web_dashboard` that the site cannot use: its map and scan messages do not say how long their binary data is, which the relay needs. It also has no tuning link and no Origin check. Car 1 needs the same packages Car 2 runs, which live in this repo under [`car/ros/`](../car/ros/).

What Car 1's workspace needs, matching Car 2's ([Racerbot-Car-2-Workspace](https://github.com/sfu-racerbot/Racerbot-Car-2-Workspace)):

- [ ] **Delete** the old `src/web_dashboard` and `src/usb_cam_stream`. They have the same package names as the new ones, and colcon refuses to build two packages with one name.
- [ ] **Add this repo as a submodule** at `src/web_dashboards`, as Car 2 does ([car/README.md step 1](../car/README.md#1-get-the-code-into-your-workspace)):
  ```bash
  cd ~/racerbot-ws
  git submodule add https://github.com/sfu-racerbot/web-dashboards.git src/web_dashboards
  ```
- [ ] **Install the dependencies and build** ([car/README.md steps 2 and 3](../car/README.md#2-install-the-dependencies)), including `sudo apt install ros-jazzy-foxglove-bridge`.
- [ ] **Write Car 1's YAML** ([car/README.md step 4](../car/README.md#4-write-your-cars-yaml)), for example `src/racerbot_launch/config/web_dashboard_rb1.yaml`. Start from Car 2's [`web_dashboard_rb2.yaml`](https://github.com/sfu-racerbot/Racerbot-Car-2-Workspace/blob/main/src/racerbot_launch/config/web_dashboard_rb2.yaml) and change what differs on Car 1:

  ```yaml
  web_dashboard_node:
    ros__parameters:
      allowed_origins: ["https://dashboard.sfuracerbot.ca"]
      # Car 1's base_link->laser transform is 0.27 m
      # (f1tenth_stack bringup_launch.py, static_baselink_to_laser). Re-measure
      # if the LiDAR mount changes; this must match that transform.
      laser_offset_x: 0.27
      # Only nodes that advertise a live_tunable_spec. Car 1's current
      # pure_pursuit and gap_follow do not yet; bring them over from Car 2's
      # workspace, or leave this list empty until then.
      tuning_nodes: [pure_pursuit_node, gap_follow_node]
      tuning_config_files: [pure_pursuit/config/pure_pursuit.yaml, gap_follow/config/gap_follow.yaml]
      killable_nodes: [pure_pursuit_node, gap_follow_node, pure_pursuit_launch.py, gap_follow_launch.py]
      map_roots: [~/.ros/racerbot_auto]

  usb_cam_stream_node:
    ros__parameters:
      # Car 1 has a plain USB webcam, not Car 2's RealSense: read the device
      # directly (check the path with `v4l2-ctl --list-devices`).
      device: /dev/video0
  ```

  The LiDAR model makes no difference to the dashboard: Car 1's Hokuyo publishes `/scan` like Car 2's. Pose comes from `/pf/viz/inferred_pose` (particle_filter) or `/slam_pose`, both subscribed by default.

**Working when:** `colcon list --packages-select web_dashboard usb_cam_stream` prints each package **once**, under `src/web_dashboards/car/ros/`.

## 3. Try the three servers by hand — on the car

[car/README.md step 5](../car/README.md#5-try-the-three-servers-by-hand), with Car 1's YAML:

```bash
ros2 launch web_dashboard web_dashboard_launch.py car_config:=$HOME/racerbot-ws/src/racerbot_launch/config/web_dashboard_rb1.yaml
ros2 launch usb_cam_stream usb_cam_stream_launch.py car_config:=$HOME/racerbot-ws/src/racerbot_launch/config/web_dashboard_rb1.yaml
ros2 launch web_dashboard foxglove_bridge_launch.py
~/racerbot-ws/src/web_dashboards/car/check.sh
```

Run each in its own terminal, after `source /opt/ros/jazzy/setup.bash && source ~/racerbot-ws/install/setup.bash`.

**Working when:** `check.sh` says `ok` for ports 8080, 8765 and 9090, and the dashboard's startup line lists `https://dashboard.sfuracerbot.ca` under `allowed origins`.

## 4. Create the tunnel and install cloudflared — 👤 Dashboard + on the car

[car/README.md step 7](../car/README.md#7-create-the-cars-tunnel-and-install-cloudflared):

1. **Networking** > **Tunnels** > **Create a tunnel** > **Cloudflared**. Name it `rb1`.
2. Operating system **Debian**, architecture **arm64** (Car 1 is a Jetson Orin Nano Super). Copy only the **token**, the long string after `cloudflared service install`. Treat it like a password.
3. On Car 1:
   ```bash
   sudo ~/racerbot-ws/src/web_dashboards/car/cloudflared/install.sh <paste-the-token>
   ```

**Working when:** the script ends with `cloudflared installed and running`, and the `rb1` tunnel shows **Healthy** in the dashboard.

Car 1 needs **its own** tunnel. Never reuse Car 2's token.

## 5. Add the three routes — 👤 Dashboard

[cloudflare-setup.md step 4](cloudflare-setup.md#4-publish-the-cars-three-services-through-its-tunnel---dashboard), on the **`rb1`** tunnel's **Routes** tab. Choose **Add route** > **Published application**, three times:

| Subdomain | Domain | Service |
|---|---|---|
| `rb1-dash-origin` | `sfuracerbot.ca` | `http://localhost:8080` |
| `rb1-bridge-origin` | `sfuracerbot.ca` | `http://localhost:8765` |
| `rb1-cam-origin` | `sfuracerbot.ca` | `http://localhost:9090` |

**Working when**, from any machine:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://rb1-dash-origin.sfuracerbot.ca/
```

prints `401` (Access refusing a request with no token; correct). A `200` means step 1 is missing that hostname: fix it before going on. A `403` page from a challenge means the WAF rule's exception is wrong ([cloudflare-setup.md](cloudflare-setup.md#if-your-zone-has-a-waf-challenge-rule---dashboard)).

## 6. Start the bridge at boot — on the car

Stop the hand-started bridge from step 3 (`Ctrl+C`), then run [car/README.md step 10](../car/README.md#10-start-the-bridge-at-boot) with Car 1's user and workspace:

```bash
sudo ~/racerbot-ws/src/web_dashboards/car/systemd/install.sh <user> /home/<user>/racerbot-ws
```

**Working when:** it prints `active (running)`.

If Car 1's stack sets `ROS_DOMAIN_ID` or `RMW_IMPLEMENTATION`, put the same values in `/etc/default/foxglove-bridge`. Otherwise the bridge starts but shows no topics.

## 7. Check every hop

On Car 1, with the dashboard running:

```bash
ros2 run web_dashboard remote_check --site https://dashboard.sfuracerbot.ca --car rb1
```

**Working when:** it ends with `Everything this car can check is fine`.

Then in a browser, open **https://dashboard.sfuracerbot.ca/rb1/check** (or select **Diagnostics** on Car 1's card).

**Working when:** every hop is marked **OK**, including `relay websocket (from the Durable Object)`. Then open the landing page, choose Car 1's **Simple**: the link row reads `CAR ONLINE · 1 WATCHING`, and the map, LiDAR and camera appear. **Advanced** (Chrome or Edge) shows Car 1's topics.

If a line fails, its `fix` says what to change. [car/README.md, Troubleshooting](../car/README.md#troubleshooting) covers the rest.
