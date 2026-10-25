# Setting up Car 1 (`rb1`)

> **Who this is for:** whoever brings Car 1 onto https://dashboard.sfuracerbot.ca.
> **Read first:** nothing. This page is a checklist that points into [car/README.md](../car/README.md) (the full car guide) and [cloudflare-setup.md](cloudflare-setup.md) (the Cloudflare clicks) with Car 1's names filled in.
> **What's in it:** what is already done, what is left to do in Cloudflare, and how to know it works.

## What is already done

**The site already knows Car 1.** `rb1` is in `CARS` in [`wrangler.jsonc`](../wrangler.jsonc), so the landing page shows a **Car 1** card and these addresses exist:

| Address | What it is |
|---|---|
| `https://dashboard.sfuracerbot.ca/rb1/simple/` | Simple dashboard |
| `https://dashboard.sfuracerbot.ca/rb1/advanced/` | Advanced (Lichtblick), via the landing page's button |
| `https://dashboard.sfuracerbot.ca/rb1/simple/camera.html` | Camera on its own |
| `https://dashboard.sfuracerbot.ca/rb1/check` | Tests every hop from the site to Car 1 |

**Nothing changes in the Worker's settings.** Car 1 uses the same service token (`ACCESS_CLIENT_ID`, `ACCESS_CLIENT_SECRET`) and the same team email list as Car 2. The WAF rule's `-origin.sfuracerbot.ca` exception already covers Car 1's hostnames.

**The car side is done** (checked on the car 2026-10-24):

- [x] Car 1's workspace ([Racerbot-Car-1-Workspace](https://github.com/sfu-racerbot/Racerbot-Car-1-Workspace)) has this repo as the `src/web_dashboards` submodule, built, and its own settings in `src/racerbot_launch/config/web_dashboard_rb1.yaml` (site origin, `laser_offset_x: 0.26`, USB webcam at `/dev/video0`). A test there checks each value against the file it has to agree with.
- [x] `cloudflared` runs as a service with Car 1's tunnel token (tunnel id `bc0ee647-8c4b-4703-b2fa-29c0fa1c61e6`), kept in `/etc/cloudflared/tunnel.env` and not on the command line.
- [x] `foxglove-bridge` runs at boot (`:8765`).
- [x] **Car 1 only:** `dashboard_node` also runs at boot (`web-dashboard.service`, `:8080`). The camera (`:9090`) is still started by hand: `ros2 launch racerbot_launch webcam_launch.py`.
- [x] Remote desktop (x11vnc → noVNC on `127.0.0.1:6080`) and sshd (`:22`) are running, for `rd-rb1` and `ssh-rb1`.

**What's left is all in the Cloudflare dashboard.** On 2026-10-24 Car 1's tunnel had a single route, `racerbotcar1remotedesktopsecured.sfuracerbot.ca` → `http://localhost:6080`, and none of the hostnames below existed. Until the steps below are done, the Car 1 card says `Idle · nobody watching`, and opening a dashboard turns it red (`Offline`) with the reason.

## Car 1's names

| Thing | Value |
|---|---|
| Car id | `rb1` |
| Tunnel | Car 1's, id `bc0ee647-8c4b-4703-b2fa-29c0fa1c61e6` |
| Dashboard hostname → port | `rb1-dash-origin.sfuracerbot.ca` → `http://localhost:8080` |
| Bridge hostname → port | `rb1-bridge-origin.sfuracerbot.ca` → `http://localhost:8765` |
| Camera hostname → port | `rb1-cam-origin.sfuracerbot.ca` → `http://localhost:9090` |
| Remote desktop hostname → port | `rd-rb1.sfuracerbot.ca` → `http://localhost:6080` |
| SSH hostname → port | `ssh-rb1.sfuracerbot.ca` → `ssh://localhost:22` |
| Access applications | `rb1 origins` (the site's service token), `rb1 remote` (the team's emails) |

## Order

Do it in this order, so Car 1's hostnames are never open to the internet, not even briefly. Each lock comes before the route it guards:

1. [Lock the origin hostnames](#1-lock-car-1s-origin-hostnames---dashboard)
2. [Add the three origin routes](#2-add-the-three-origin-routes---dashboard)
3. [Remote desktop and SSH](#3-remote-desktop-and-ssh---dashboard)
4. [Refresh the tunnel token](#4-refresh-the-tunnel-token---dashboard--on-the-car)
5. [Check every hop](#5-check-every-hop)

## 1. Lock Car 1's origin hostnames — 👤 Dashboard

[cloudflare-setup.md step 2](cloudflare-setup.md#2-lock-the-cars-three-origin-hostnames-to-that-token---dashboard), with Car 1's names:

1. **Zero Trust** > **Access controls** > **Applications** > **Create new application** > **Self-hosted and private**.
2. Name it `rb1 origins`. **Add public hostname** three times: `rb1-dash-origin`, `rb1-bridge-origin`, `rb1-cam-origin`, each on `sfuracerbot.ca`.
3. **Access policies:** one policy, `worker only`, **Action: Service Auth**, **Include: Service Token** = `racerbot-dashboard-worker` (the token Car 2 already uses). No other policy.
4. **Additional settings:** turn on **401 Response for Service Auth policies**.
5. **Create**.

**Working when:** the application lists the three `rb1-…` hostnames and exactly one policy, with action Service Auth.

Use a new application rather than adding the hostnames to `rb2 origins`, so either car can be removed on its own later.

## 2. Add the three origin routes — 👤 Dashboard

[cloudflare-setup.md step 4](cloudflare-setup.md#4-publish-the-cars-three-services-through-its-tunnel---dashboard), on **Car 1's** tunnel's **Routes** tab. Choose **Add route** > **Published application**, three times:

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

## 3. Remote desktop and SSH — 👤 Dashboard

[cloudflare-setup.md, "Optional: remote desktop and SSH"](cloudflare-setup.md#optional-remote-desktop-and-ssh-for-people---dashboard), with Car 1's names — the same format as Car 2's `rd-rb2` and `ssh-rb2`:

1. A new application `rb1 remote`, hostnames `rd-rb1` and `ssh-rb1` on `sfuracerbot.ca`, policy **Allow** for the team's emails.
2. Then, on Car 1's tunnel, two routes: `rd-rb1` → `http://localhost:6080`, `ssh-rb1` → `ssh://localhost:22`.
3. Then delete the old route `racerbotcar1remotedesktopsecured.sfuracerbot.ca`, and its Access application once nothing else uses it. It points at the same noVNC; `rd-rb1` replaces it.

**Working when:** `curl -s -o /dev/null -w "%{http_code}\n" https://rd-rb1.sfuracerbot.ca/` prints `302`, and `https://rd-rb1.sfuracerbot.ca/vnc.html` shows Car 1's screen (its login screen if nobody is logged in) after you sign in.

## 4. Refresh the tunnel token — 👤 Dashboard + on the car

Until 2026-10-24 Car 1's tunnel token was on `cloudflared`'s command line, readable by any user on the car. It was moved to a root-only file, but treat the old one as exposed:

1. Car 1's tunnel's page > **Refresh token**. Copy the new token.
2. On Car 1: `sudo ~/racerbot-ws/src/web_dashboards/car/cloudflared/install.sh`, and paste it at the prompt.

**Working when:** the tunnel shows **Healthy** again within a minute, and `~/racerbot-ws/src/web_dashboards/car/check.sh` on the car shows no `WARN`.

## 5. Check every hop

On Car 1:

```bash
ros2 run web_dashboard remote_check --site https://dashboard.sfuracerbot.ca --car rb1
```

**Working when:** it ends with `Everything this car can check is fine`.

Then in a browser, open **https://dashboard.sfuracerbot.ca/rb1/check** (or select **Diagnostics** on Car 1's card).

**Working when:** every hop is marked **OK**, including `relay websocket (from the Durable Object)`. Then open the landing page, choose Car 1's **Simple**: the link row reads `CAR ONLINE · 1 WATCHING`, and the map and LiDAR appear (the camera once someone starts it). **Advanced** (Chrome or Edge) shows Car 1's topics.

If a line fails, its `fix` says what to change. [car/README.md, Troubleshooting](../car/README.md#troubleshooting) covers the rest.
