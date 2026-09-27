# Advanced dashboard (Lichtblick)

> **Who this is for:** anyone upgrading Lichtblick, changing the team's default layout, or wondering why Advanced shows what it shows.
> **Read first:** [../../docs/decisions.md](../../docs/decisions.md#lichtblick-tag-subpath-deep-link-layout) for why this tag and how it was checked.
> **What's in it:** how Lichtblick gets built and shipped, the default layout, and every name in it that still needs confirming on the car.

**Advanced** is [Lichtblick](https://github.com/lichtblick-suite/lichtblick) (MPL-2.0; the open-source fork of Foxglove Studio), served at `/<car>/advanced/` and connected to the car's `foxglove_bridge` through `/<car>/bridge`. It sees every ROS 2 topic, service and parameter. No Foxglove account or service is involved: the browser talks to this site, and the site to the car.

**It needs Chrome or Edge.** Lichtblick's web build checks for a Chromium browser and shows a compatibility warning in any other.

## What is here, and what is not

| File | What it is |
|---|---|
| `LICHTBLICK_VERSION` | The release tag built and deployed. Currently `v1.29.1`. |
| `build.sh` | Clones that tag and runs Lichtblick's own `web:build:prod`. Output goes to `.build/`, which git ignores. |
| `layouts/racerbot-default.json` | The layout a browser gets the first time it opens Advanced. |

Neither Lichtblick's source nor its build output is committed. Cloudflare's build (Workers Builds, `npm run build`) builds it from source on every deploy, and the GitHub workflow does the same on every push as a check.

## Building it locally

**Terminal 1**, from the repo root. Needs Node 22, git, about 4 GB of disk and a few minutes.

```bash
apps/advanced/build.sh
node scripts/assemble.mjs --require-advanced
```

**Working when:** `assemble.mjs` prints the largest Lichtblick files, then `asset limits: ok`.

**If it doesn't:** `corepack` must be able to download Yarn from `repo.yarnpkg.com`. On a network that blocks it, let CI do the build: every pull request builds Lichtblick and runs the same check.

## Upgrading Lichtblick

1. Change `LICHTBLICK_VERSION` to the new tag.
2. Open a pull request. CI builds it and fails if any file is over Cloudflare's 25 MiB limit.
3. Check locally (`npm run dev`, after building): Advanced opens at `/rb2/advanced/`, the deep link connects, and the default layout loads.

Keep the tag at `v1.22.1` or later: earlier releases cannot speak `foxglove.sdk.v1`, the only subprotocol the Jazzy SDK-based `foxglove_bridge` offers.

## The default layout

Lichtblick keeps each person's layouts in their own browser. This file is what a browser starts with; after that, people's own changes win. To give everyone a changed default, edit the file **and** tell people to pick it again from Lichtblick's **Layouts** menu (or clear the site's storage).

`scripts/assemble.mjs` puts it into Lichtblick's `index.html` in the slot Lichtblick provides for exactly this (`LICHTBLICK_SUITE_DEFAULT_LAYOUT`).

| Panel | Shows | Confirmed on the car? |
|---|---|---|
| 3D, display frame `map` | `/map`, `/scan`, TF, `/pf/viz/inferred_pose` (the particle filter's pose) | Topic names: yes, from the car repo's `docs/architecture.md` and `web_dashboard.yaml` |
| Image | `/camera/camera/color/image_raw/compressed` | **TODO.** The car publishes the RealSense's raw image on `/camera/camera/color/image_raw`; a `/compressed` version exists only if `image_transport`'s compressed plugin is installed on the car. The USB camera node publishes no ROS topic at all. The panel's title says TODO until this is confirmed |
| Plot | commanded `/ackermann_cmd.drive.speed` vs measured `/odom.twist.twist.linear.x` | Yes |
| Raw Messages | `/drive_intent` (JSON in `.data`) | Yes |
| Parameters | every node's parameters | Yes (a panel, no names needed) |
| Service Call | `/pure_pursuit_node/get_parameters` for `max_speed` and `lookahead_distance` — read-only | Yes: every rclpy node offers it, and `pure_pursuit_node` is in the dashboard's `tuning_nodes` |

**Also TODO:** the particle filter's particle cloud topic (not named anywhere in the car repo's docs), and whether `foxglove_bridge` is installed and launched on the car at all — the car repo does not mention it yet. That is the car session's side of the work.

## Safety note

Lichtblick can **publish** to any topic and **call** any service, with no arming step and none of the simple dashboard's guards. The team's `foxglove_bridge` configuration on the car decides what is allowed (its `client_publish` capability and topic/service whitelists). Treat Advanced as an engineering tool, not a trackside one.
