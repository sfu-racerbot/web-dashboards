# Setting up a car

> **Who this is for:** anyone setting up a car — SFU Racerbot's or your own team's — so it shows up on a copy of this dashboards site. Linux command-line basics assumed; no Cloudflare experience needed.
> **Read first:** the [top-level README](../README.md) (what the site is). You need a car running **Ubuntu 24.04 with ROS 2 Jazzy** and a [colcon](https://docs.ros.org/en/jazzy/Tutorials/Beginner-Client-Libraries/Colcon-Tutorial.html) workspace — the folder you build your ROS packages in.
> **You'll be able to:** build this repo's two ROS packages on your car, give them your car's settings, connect the car to the site through a Cloudflare tunnel, and check every hop between them.
> **Time:** about an hour the first time, most of it in the Cloudflare dashboard.

Everything the site needs on a car is in this repo: the two ROS 2 packages under [`ros/`](ros/), the bridge's boot service under [`systemd/`](systemd/), and the tunnel installer under [`cloudflared/`](cloudflared/). Clone one repo, build it, write one YAML file, and add your car to the site's list.

The car never talks to the internet directly. It opens one outgoing connection to Cloudflare — the **tunnel** — and Cloudflare sends it only the requests the site makes.

## Contents

- [What runs on the car](#what-runs-on-the-car)
- [What is in this folder](#what-is-in-this-folder)
- [Before you start](#before-you-start)
- Steps: [1 Get the code](#1-get-the-code-into-your-workspace) · [2 Install dependencies](#2-install-the-dependencies) · [3 Build](#3-build-the-two-packages) · [4 Your car's YAML](#4-write-your-cars-yaml) · [5 Try it by hand](#5-try-the-three-servers-by-hand) · [6 Lock down Cloudflare](#6-lock-things-down-in-cloudflare-first) · [7 Tunnel](#7-create-the-cars-tunnel-and-install-cloudflared) · [8 Routes](#8-point-the-cars-hostnames-at-the-three-ports) · [9 Add your car to the site](#9-add-your-car-to-the-site) · [10 Bridge at boot](#10-start-the-bridge-at-boot) · [11 Check every hop](#11-check-every-hop)
- [Safety](#safety)
- [Running the tests](#running-the-tests)
- [Coming from the old layout](#coming-from-the-old-layout)
- [Which car software version the site needs](#which-car-software-version-the-site-needs)
- [Troubleshooting](#troubleshooting)

## What runs on the car

| Program | Port | What it is for | Starts | Comes from |
|---|---|---|---|---|
| `dashboard_node` | 8080 | The Simple dashboard's data: map, LiDAR, pose, tuning, processes, saved maps | **by hand** | [`ros/web_dashboard`](ros/web_dashboard/) |
| `usb_cam_stream` | 9090 | The camera, as an MJPEG video stream | **by hand** | [`ros/usb_cam_stream`](ros/usb_cam_stream/) |
| `foxglove_bridge` | 8765 | The Advanced dashboard (Lichtblick): every ROS 2 topic, service and parameter | **at boot** — the only service this repo installs | `apt`, configured by [`ros/web_dashboard`](ros/web_dashboard/) |
| `cloudflared` | none | The tunnel: carries the site's requests to the three ports above | at boot | `apt`, installed by [`cloudflared/install.sh`](cloudflared/install.sh) |

A **tunnel** is a program on the car that keeps an outgoing connection open to Cloudflare. Requests for the car's three hostnames (`<car>-dash-origin.<your domain>` and so on) travel down it to `localhost:8080`, `:8765` and `:9090`. No port is opened on the car's router or firewall.

The dashboard and camera are started by hand so that nothing new runs on the car unless someone asked for it.

## What is in this folder

| Path | What it is |
|---|---|
| [`ros/web_dashboard/`](ros/web_dashboard/) | ROS 2 package: `dashboard_node`, `remote_check`, and foxglove_bridge's config and launch file. Its [README](ros/web_dashboard/README.md) documents the code |
| [`ros/usb_cam_stream/`](ros/usb_cam_stream/) | ROS 2 package: the camera's MJPEG stream. [README](ros/usb_cam_stream/README.md) |
| [`systemd/`](systemd/) | `foxglove-bridge.service` (a template), its wrapper script, and `install.sh` |
| [`cloudflared/install.sh`](cloudflared/install.sh) | Installs `cloudflared` from Cloudflare's package repository and runs the car's tunnel as a service |
| [`check.sh`](check.sh) | Says whether the three ports and the tunnel are up. Read-only; run it any time |
| [`docs/`](docs/) | The deep docs: [web-dashboard.md](docs/web-dashboard.md) (every panel, tuning, the wire contract), [foxglove-bridge.md](docs/foxglove-bridge.md), [usb-camera-livestream.md](docs/usb-camera-livestream.md) |
| [`tools/`](tools/) | Benchmarks and a wire-format check for developers |

## Before you start

- [ ] The car runs **Ubuntu 24.04 with ROS 2 Jazzy**. SFU Racerbot's cars are Jetson Orin Nano Supers; any Jazzy machine works.
- [ ] You have a colcon workspace on the car — this guide calls it `~/racerbot-ws`; use your own path everywhere you see that.
- [ ] Someone with access to the Cloudflare account that owns your domain can do steps 6–9 in the dashboard, or already has.
- [ ] You have a **car id**: a short lower-case name like `rb2`. It appears in the site's URLs (`/rb2/check`) and in the car's hostnames (`rb2-dash-origin.<your domain>`).

## 1. Get the code into your workspace

**Terminal 1, on the car.** Either clone it into your workspace's `src/`:

```bash
cd ~/racerbot-ws/src
git clone https://github.com/sfu-racerbot/web-dashboards.git web_dashboards
```

or, if your workspace is a git repository, add it as a submodule pinned to a commit — SFU Racerbot's car workspace does this:

```bash
cd ~/racerbot-ws
git submodule add https://github.com/sfu-racerbot/web-dashboards.git src/web_dashboards
```

**Working when:** `ls ~/racerbot-ws/src/web_dashboards/car/ros` lists `usb_cam_stream` and `web_dashboard`.

colcon finds the two packages under `car/ros/` by itself. The rest of the repo (the site's `apps/`, `worker/`, `tools/`) has no ROS packages in it, and `apps/` and `tools/` carry a `COLCON_IGNORE` file so it stays that way. Don't run `npm ci` in this copy on the car: you don't need the site's JavaScript packages there.

## 2. Install the dependencies

**Terminal 1, on the car** (needs sudo):

```bash
source /opt/ros/jazzy/setup.bash
cd ~/racerbot-ws
rosdep install --from-paths src/web_dashboards/car/ros --ignore-src -r -y
sudo apt install ros-jazzy-foxglove-bridge
```

**Working when:** `ros2 pkg prefix foxglove_bridge` prints a path instead of `Package not found`.

For camera images in Lichtblick, also `sudo apt install ros-jazzy-image-transport-plugins`. Without it the bridge offers no camera (it hides raw frames on purpose); the Simple dashboard's MJPEG camera is unaffected.

**`drive_intent` is optional.** The intent arrow and decision panel read `/drive_intent`, whose schema lives in SFU Racerbot's car workspace ([`src/drive_intent`](https://github.com/sfu-racerbot/Racerbot-Car-2-Workspace/tree/main/src/drive_intent)). Without it, the dashboard works and says `drive intent: OFF` once at startup. To use it, copy that package into your workspace and publish the schema from your driving node.

## 3. Build the two packages

**Terminal 1, on the car:**

```bash
source /opt/ros/jazzy/setup.bash
cd ~/racerbot-ws
colcon build --symlink-install --packages-select web_dashboard usb_cam_stream
source install/setup.bash
```

**Working when:** the build ends `2 packages finished`, and `colcon list --packages-select web_dashboard usb_cam_stream` prints each once, under `src/web_dashboards/car/ros/`.

On an 8 GB Jetson, add `--parallel-workers 1` to a full-workspace build.

## 4. Write your car's YAML

The packages ship **generic** defaults: no site is allowed to connect, no node is tunable, nothing is stoppable, no map folder is listed, and the LiDAR sits at `base_link`. Your car's settings go in one YAML file of your own, which the launch files load *on top of* the defaults — so it holds only what you change.

Keep it in your own workspace (in a package's `config/`, say), not in this repo.

**Example**, `~/racerbot-ws/src/my_car/config/dashboard_my_car.yaml`:

```yaml
web_dashboard_node:
  ros__parameters:
    # Your copy of the site, exactly: https, no path, no trailing slash.
    # Without it the site gets HTTP 403 and shows CAR OFFLINE.
    allowed_origins: ["https://dashboard.example.org"]
    # How far your LiDAR sits ahead of base_link, in metres. Must match your
    # base_link->laser static transform.
    laser_offset_x: 0.25
    # Driving nodes the tuning panel may reach. Each must also advertise a
    # live_tunable_spec (docs/web-dashboard.md, "The live_tunable_spec contract").
    tuning_nodes: [my_controller_node]
    tuning_config_files: [my_controller/config/my_controller.yaml]
    # Processes the stop panel may end: your driving nodes and their launches.
    # The actuation path (ackermann_mux, joy, the VESC chain) is refused whatever you list.
    killable_nodes: [my_controller_node, my_controller_launch.py]
    # Where your tooling writes saved runs, if anywhere.
    map_roots: [~/.ros/my_runs]

usb_cam_stream_node:
  ros__parameters:
    device: /dev/video0      # or, for a camera with its own ROS driver:
    # image_topic: /camera/camera/color/image_raw
```

Every key, with its default and meaning, is in the [parameter reference](docs/web-dashboard.md#parameter-reference) and the camera's [parameter reference](docs/usb-camera-livestream.md#parameter-reference). SFU Racerbot car 2's real file is [`racerbot_launch/config/web_dashboard_rb2.yaml`](https://github.com/sfu-racerbot/Racerbot-Car-2-Workspace/blob/main/src/racerbot_launch/config/web_dashboard_rb2.yaml).

## 5. Try the three servers by hand

Before touching Cloudflare, check each one runs. In each terminal on the car, first:

```bash
source /opt/ros/jazzy/setup.bash && source ~/racerbot-ws/install/setup.bash
```

**Terminal 1** — the dashboard's server:

```bash
ros2 launch web_dashboard web_dashboard_launch.py car_config:=$HOME/racerbot-ws/src/my_car/config/dashboard_my_car.yaml
```

**Working when:** the log says it is serving on port 8080, and its startup line lists your site under `allowed origins`.

**Terminal 2** — the camera:

```bash
ros2 launch usb_cam_stream usb_cam_stream_launch.py car_config:=$HOME/racerbot-ws/src/my_car/config/dashboard_my_car.yaml
```

**Working when:** the log says the stream is on port 9090. With no camera plugged in it keeps running and reports it is waiting for the device; that is fine.

**Terminal 3** — the bridge:

```bash
ros2 launch web_dashboard foxglove_bridge_launch.py
```

**Working when:** the log shows `Server listening on port 8765`.

**Terminal 4** — check all three:

```bash
~/racerbot-ws/src/web_dashboards/car/check.sh
```

**Working when:** the three port lines say `ok`. The `cloudflared` line says `MISSING` until step 7.

Leave the dashboard and camera running if you like — they are what you start by hand from now on. Stop the bridge (`Ctrl+C`) before step 10 makes it a service.

## 6. Lock things down in Cloudflare first

**👤 In the Cloudflare dashboard**, before anything is reachable: follow [docs/cloudflare-setup.md](../docs/cloudflare-setup.md) **steps 1–3** — the site's service token, an Access application on the car's three origin hostnames that only that token passes, and the team's email list on the site.

Doing this first means the car's hostnames are never, even briefly, open to the internet.

## 7. Create the car's tunnel and install cloudflared

**👤 In the Cloudflare dashboard:**

1. Go to **Networking** > **Tunnels** and select **Create a tunnel**. Choose **Cloudflared**.
2. Name it after the car, for example `rb2`, and select **Create Tunnel**.
3. For the operating system choose **Debian**, and your car's architecture (**arm64** for a Jetson).
4. Of the commands the page shows, copy only the **token**: the long string after `cloudflared service install`. Treat it like a password.

**Terminal 1, on the car** (needs sudo):

```bash
sudo ~/racerbot-ws/src/web_dashboards/car/cloudflared/install.sh <paste-the-token>
```

**Working when:** the script ends with `cloudflared installed and running`, and within a minute the dashboard shows the tunnel as **Healthy**. Select **Continue** there.

## 8. Point the car's hostnames at the three ports

**👤 In the Cloudflare dashboard:** [docs/cloudflare-setup.md](../docs/cloudflare-setup.md) **step 4** adds the three routes. With your car id and domain in place of `rb2` and `sfuracerbot.ca`:

| Hostname | Service |
|---|---|
| `<car>-dash-origin.<your domain>` | `http://localhost:8080` |
| `<car>-bridge-origin.<your domain>` | `http://localhost:8765` |
| `<car>-cam-origin.<your domain>` | `http://localhost:9090` |

## 9. Add your car to the site

The site only talks to the cars in its `CARS` list, in [`wrangler.jsonc`](../wrangler.jsonc):

```jsonc
"CARS": {
  "rb2": {
    "name": "Car 2",
    "dash_origin": "https://rb2-dash-origin.sfuracerbot.ca",
    "bridge_origin": "https://rb2-bridge-origin.sfuracerbot.ca",
    "cam_origin": "https://rb2-cam-origin.sfuracerbot.ca"
  }
}
```

**On your own copy of the site** (your fork or copy of this repo): replace SFU Racerbot's entry with yours — key = your car id, the three origins = your step-8 hostnames — and replace `sfuracerbot.ca` in the route and `PUBLIC_ORIGIN` with your domain. Then connect the repo and give the Worker the service token: [docs/cloudflare-setup.md](../docs/cloudflare-setup.md) **steps 5–7**.

**Adding a car to SFU Racerbot's site:** one entry in `CARS`, merged to `main` — see [adding a car](../docs/cloudflare-setup.md#adding-a-car).

**Working when:** the site's landing page lists your car.

## 10. Start the bridge at boot

The bridge is the only thing that starts at boot. `install.sh` fills the unit in with your user, your workspace and the path of the `car/systemd/` folder you run it from, so run it from the checkout you will keep.

**Terminal 1, on the car** (needs sudo), with your user name and workspace path:

```bash
sudo ~/racerbot-ws/src/web_dashboards/car/systemd/install.sh <user> /home/<user>/racerbot-ws
```

**Working when:** it prints `active (running)`, and `journalctl -u foxglove-bridge -n 20` shows `Server listening on port 8765`.

To see its log: `journalctl -u foxglove-bridge -f`. To stop it: `sudo systemctl stop foxglove-bridge`. To stop it starting at boot: `sudo systemctl disable foxglove-bridge`.

> **The bridge must be on the stack's ROS domain.** The wrapper leaves `ROS_DOMAIN_ID` and `RMW_IMPLEMENTATION` unset (domain 0, Fast DDS). If your stack sets either, put the same values in `/etc/default/foxglove-bridge`, which the service reads. A bridge on the wrong domain starts fine and shows no topics.

## 11. Check every hop

**Terminal 1, on the car**, with the dashboard running (step 5):

```bash
source /opt/ros/jazzy/setup.bash && source ~/racerbot-ws/install/setup.bash
ros2 run web_dashboard remote_check --site https://<your site> --car <car id>
```

It is read-only. It checks the three local ports, a handshake exactly as the site's relay makes it, the tunnel's routes, public DNS, and how Cloudflare answers each hostname, and prints a fix for anything wrong.

**Working when:** it ends with `Everything this car can check is fine`.

**Then, in a browser:** open `https://<your site>/<car id>/check`. The site tries each hop to the car with its real service token and says which one fails.

**Working when:** every line passes. Then open the site, pick your car and **Simple**: the row under `CONNECTED` reads `CAR ONLINE · 1 WATCHING`, and the map, LiDAR and camera appear. **Advanced** (Chrome or Edge) connects to the bridge.

## Safety

**Nothing this repo installs or starts can move the car.**

`dashboard_node` and `usb_cam_stream` publish to no ROS topic. Starting or stopping them changes nothing about how the car drives.

**The bridge lets a browser publish to no topic at all.** Do not add `clientPublish` back to its capabilities. The rule, in the car workspace it came from, is that anything publishing to `/drive` or `/ackermann_cmd` must implement the LB deadman — let go of the gamepad's LB button and the car stops — and a browser tab cannot.

This was measured, not assumed: on foxglove_bridge 3.5.0, with `clientPublish` on, `client_topic_whitelist` is **not enforced** — a client published to `/drive` and the message arrived. `test_foxglove_bridge_config.py` fails if `clientPublish` comes back. Details: [docs/foxglove-bridge.md](docs/foxglove-bridge.md#why-clients-cannot-publish-anything).

`/initialpose` is off too, as a consequence. Re-seeding localization under a moving controller gives it a confidently wrong position, which is more dangerous than no position. Seed it from RViz on the car.

**Lichtblick can still set parameters and call services** without the Simple dashboard's arming step. A service call like `/slam_toolbox/reset` goes through with no "is anything driving?" check. Keep the Access list to people you'd trust at the laptop; for a watch-only Advanced, remove `parameters` and `services` from `capabilities` in the bridge YAML.

**The Simple dashboard's write paths are bounded, not locked.** Tuning, stopping a process, resetting SLAM and deleting a saved run all reach the car. Read the [security note](docs/web-dashboard.md#security-note), and switch off any you don't want in your car YAML (`enable_tuning`, `enable_process_control`, `enable_slam_reset`, `enable_map_delete`).

**The SLAM reset only refuses while a *known* controller runs.** Resetting `slam_toolbox` under a driving controller makes its pose jump or freeze, so the dashboard refuses while one runs — but that list (`proccontrol.DRIVING_CONTROLLERS`) names SFU Racerbot's controllers, not yours. **Unless yours are on it, set `enable_slam_reset: false` in your car YAML.** ([docs/follow-ups.md](../docs/follow-ups.md#the-car-side-car) item 15.)

**On the car's own network, ports 8080 and 9090 need no login.** Both listen on every interface by default (`host: 0.0.0.0`). To make the site the only way in, set `host: 127.0.0.1` for both nodes in your car YAML. The tunnel only needs localhost.

## Running the tests

Three runners, each for a different part:

| Runner | Runs | Where |
|---|---|---|
| `npm test` | The site: the Simple dashboard's JavaScript tests (including the protocol-version check against `ros/web_dashboard`), the Worker, the mock car | Any machine with Node 22; CI |
| [`car/ros/run_ros_free_tests.sh`](ros/run_ros_free_tests.sh) | Every car-side Python test that needs **no ROS**, by name — 676 tests, including the bridge's safety test | Any machine with Python 3.12, `pytest tornado psutil numpy pyyaml setuptools`, and `drive_intent` on `PYTHONPATH`; CI |
| `colcon test` | Everything above in the two packages, **plus** the tests that import `rclpy`/`cv2`: `usb_cam_stream`'s two files and `test_dashboard_node_defaults.py` | A car, with the workspace built |

The script refuses to run if a test file is on neither of its two lists, so a new test cannot silently go unrun.

**Run ROS tests on an isolated ROS domain.** They start real nodes, which join whatever ROS graph they can see — on a car with its stack up, that is the car's own. Use a domain and discovery range nothing else uses:

**Terminal 1, on the car:**

```bash
source /opt/ros/jazzy/setup.bash && source ~/racerbot-ws/install/setup.bash
cd ~/racerbot-ws
ROS_DOMAIN_ID=79 ROS_AUTOMATIC_DISCOVERY_RANGE=LOCALHOST \
  colcon test --packages-select web_dashboard usb_cam_stream
colcon test-result --verbose
```

**Working when:** `colcon test-result` reports 0 errors and 0 failures.

The intent tests need the `drive_intent` package importable (on a car, source a workspace that has it; CI fetches SFU Racerbot's at a pinned commit). Test-quality rules for this repo: [TEST_QUALITY_STANDARDS.md](../TEST_QUALITY_STANDARDS.md).

## Coming from the old layout

Earlier versions of this folder installed three services — `racerbot-dashboard`, `racerbot-camera` and `racerbot-foxglove-bridge` — and a launch file at `/etc/racerbot/`. They are gone: the dashboard and camera are started by hand, and the bridge is `foxglove-bridge`. If you installed the old ones, remove them (needs sudo):

```bash
sudo systemctl disable --now racerbot-dashboard racerbot-camera racerbot-foxglove-bridge
sudo rm /etc/systemd/system/racerbot-dashboard.service /etc/systemd/system/racerbot-camera.service /etc/systemd/system/racerbot-foxglove-bridge.service
sudo rm -r /etc/racerbot
sudo systemctl daemon-reload
```

Then do step 10.

**Working when:** `systemctl list-unit-files | grep -E 'racerbot|foxglove'` shows only `foxglove-bridge.service`.

## Which car software version the site needs

The site and the car have a small agreement, the **car contract**: the car's first message is a `hello` naming its protocol version, and it treats the site's shared `relay` connection and each person's `control` connection differently. It is written out in [docs/decisions.md](../docs/decisions.md#the-car-contract-as-built).

Both sides now live in this repo. `PROTOCOL_VERSION` in [`ros/web_dashboard/web_dashboard/protocol.py`](ros/web_dashboard/web_dashboard/protocol.py) is the one source of truth, and `npm test` fails if the page expects a different number. It is `1`.

A car running an older `web_dashboard` with no `hello` counts as **protocol version 0**, which the site still accepts:

| | Car without the contract (v0) | Car with it (v1) |
|---|---|---|
| Watching, relay, late joiners | works | works |
| Tuning, stop, delete, SLAM reset | work | work |
| The control link also receives the full telemetry stream | yes, doubling that tab's traffic while it is open | no |
| The car refuses writes on the shared relay link | no — but the site never sends any there | yes |
| The car knows which person made a change (`X-Racerbot-User`) | ignored | logged |
| Protocol-mismatch banner if the car and site disagree | never shown | shown on a real mismatch |

## Troubleshooting

**Start here:** `ros2 run web_dashboard remote_check --site https://<your site> --car <car id>` on the car, and `https://<your site>/<car id>/check` in a browser. Between them they name the hop that fails, and how to fix it.

| Symptom | Likely cause | Fix |
|---|---|---|
| `check.sh`: port 8080 or 9090 is `MISSING` | the dashboard or camera isn't started — they don't run at boot | Start it (step 5) |
| `check.sh`: port 8765 is `MISSING` | the bridge service isn't running | `journalctl -u foxglove-bridge -n 50` shows why. A workspace not built, or the wrong path given to `install.sh`, are the usual reasons |
| Tunnel shows **Down** in the dashboard | `cloudflared` stopped, or the car has no internet | `sudo systemctl status cloudflared`; `sudo systemctl restart cloudflared` |
| Simple says `CAR OFFLINE`, everything above is fine | the relay cannot get through | Hover the row for the relay's reason. `HTTP 401/403` from Cloudflare means the service token or the origin Access app ([cloudflare-setup.md](../docs/cloudflare-setup.md) steps 1, 2 and 6); **403 from the car** means your site isn't in `allowed_origins` in your car YAML; `HTTP 502/530` means the tunnel route or `dashboard_node` |
| The dashboard's log says `drive intent: OFF` | the `drive_intent` package isn't installed | Expected without it — see step 2 |
| Camera inset says "camera offline" | the camera isn't started, or no camera is plugged in | Start it (step 5); its log says whether it is waiting for the device |
| Advanced cannot connect | the bridge is not running, or the `<car>-bridge-origin` route is missing | `check.sh`, then step 8 |
| Advanced connects but shows no topics | the bridge is on a different ROS domain from the stack | See the note in step 10 |
| `http://<car-ip>:8080/` shows a 404 | nothing is wrong: the car serves no pages | Open the site |
