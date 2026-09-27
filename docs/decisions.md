# Decisions, and the evidence behind them

> **Who this is for:** anyone changing how this site is built or deployed, or wondering why something is the way it is.
> **Read first:** [../README.md](../README.md) for what the site is and the diagram of how a request reaches the car.
> **What's in it:** every design decision; every fact checked against Cloudflare or Lichtblick documentation or source, with a link; every place this build differs from what was asked for.

This is a running log. Add to it when you decide something; don't rewrite history.

**How things were checked.** `developers.cloudflare.com` was not reachable from the build environment. So Cloudflare's documentation was read from its source repository, [cloudflare/cloudflare-docs](https://github.com/cloudflare/cloudflare-docs), at commit `0d6b597` (2026-09-26). Each link below goes to that exact file, and the public page is named next to it.

Runtime behaviour that the docs don't state was read from [workerd](https://github.com/cloudflare/workerd) and [cloudflared](https://github.com/cloudflare/cloudflared) source. Where something was also exercised for real (`wrangler dev` with the mock car, and headless Chromium), that is said.

## Contents

- [At a glance](#at-a-glance)
- [Things the brief asked for that turned out not to be possible or not quite right](#things-the-brief-asked-for-that-turned-out-not-to-be-possible-or-not-quite-right)
- [Platform: one Worker with Static Assets and a Durable Object](#platform-one-worker-with-static-assets-and-a-durable-object)
- [Deploying: Cloudflare builds from the repo (Workers Builds)](#deploying-cloudflare-builds-from-the-repo-workers-builds)
- [Routing](#routing)
- [Static asset limits, and the Lichtblick build](#static-asset-limits-and-the-lichtblick-build)
- [Proxying WebSockets from the Worker](#proxying-websockets-from-the-worker)
- [The relay's own WebSocket to the car](#the-relays-own-websocket-to-the-car)
- [Keeping the relay asleep when nobody watches](#keeping-the-relay-asleep-when-nobody-watches)
- [Slow and dead viewers](#slow-and-dead-viewers)
- [MJPEG through the Worker and the tunnel](#mjpeg-through-the-worker-and-the-tunnel)
- [What the relay remembers for late joiners](#what-the-relay-remembers-for-late-joiners)
- [The car contract, as built](#the-car-contract-as-built)
- [The simple dashboard's changes](#the-simple-dashboards-changes)
- [Lichtblick: tag, subpath, deep link, layout](#lichtblick-tag-subpath-deep-link-layout)
- [Cloudflare Access details](#cloudflare-access-details)
- [Still unverified](#still-unverified)

## At a glance

| Decision | Verified by |
|---|---|
| One Worker + Static Assets + one Durable Object class, not Pages | Cloudflare docs, below |
| Dynamic routes reach the Worker because no file matches them; `html_handling: "none"` | Cloudflare docs; `wrangler dev` |
| Lichtblick output fits: 403 files, largest 21.16 MiB (a source map); 219 files, largest 6.79 MiB deployed | A real build of v1.29.1; `scripts/assemble.mjs` fails the build on any file over 25 MiB |
| `/control`, `/bridge`, `/camera` are passthroughs with no Worker JavaScript in the data path | Cloudflare docs (CPU limit); `wrangler dev` + mock |
| The relay opens its car connection with `fetch()` + `Upgrade: websocket` | Cloudflare docs; `wrangler dev` + mock |
| One upstream per car, whatever the viewer count | `wrangler dev` + mock: two tabs, one car connection |
| Late joiners get an identical map | Headless Chromium: two tabs' minimaps, 0 of 48,400 pixels differ |
| Car connection closes `UPSTREAM_IDLE_SEC` after the last viewer | `wrangler dev` log: `upstream_disconnect … reason: idle` |
| MJPEG streams unbuffered through the Worker | `wrangler dev` + mock: ~10 frames/s arriving continuously; cloudflared source for the tunnel half |
| Lichtblick **v1.29.1** | Source: speaks `foxglove.sdk.v1`; builds; runs under `/rb2/advanced/`; deep link connects through the Worker (headless Chromium) |

## Things the brief asked for that turned out not to be possible or not quite right

These are the places where this build knowingly does something other than exactly what was asked. Each one is explained in its own section below.

1. **Bridge logging cannot record `disconnected_at` and `close_code` on the Workers Free plan.** Recording them means running Worker JavaScript for every Lichtblick frame, and the Free plan allows 10 ms of CPU per request — a busy Lichtblick session would be cut off. The default (`BRIDGE_TRACKING=native`) logs `{user, car, connected_at}` and writes `null` for the other two. `BRIDGE_TRACKING=relay` logs all five and is meant for Workers Paid. Both modes were run. See [Proxying WebSockets](#proxying-websockets-from-the-worker).
2. **"Clear view" is answered by the relay, not refused.** The brief says the relay replies to every browser message with an error. "Clear view" is not a write — it only makes one browser forget its own copy of the map — and the car answers it with the map it holds. The relay holds the same map, so it answers the same way. Everything else a browser sends the relay gets `relay_error`. See [The simple dashboard's changes](#the-simple-dashboards-changes).
3. **The relay does not forward `tuning_armed`.** It is a per-connection message; the relay's own connection is never armed, and passing its "disarmed" to viewers would disarm the panel of somebody whose control link *is* armed. The page also ignores `tuning_armed` on the telemetry socket, as a second lock.
4. **The lichtblick fix is PR #819, which re-opened #772.** #772 was closed unmerged because of a branch-name restriction; the same change merged as [#819](https://github.com/lichtblick-suite/lichtblick/commit/f798c4728fccf8a1e225995212a5c274d1694cdd). It first shipped in **v1.22.1**.
5. **Protocol v2 would not quite halve the message count.** Merging each header with its binary removes one frame per scan and per map update, but most frames are 20 Hz `batch` frames with no binary. Measured on the mock: 42.6 → about 32 messages a second, roughly **25 % fewer**. See [costs.md](costs.md).
6. **"N viewers" is live, "car online" is only known while someone watches.** The relay holds a car connection only while it has viewers, so with nobody watching it cannot tell a healthy car from a dead one. The landing page says `idle · nobody watching` rather than showing red. Opening either dashboard is the way to check the car.

## Platform: one Worker with Static Assets and a Durable Object

**Decision:** one Worker (`racerbot-dashboard`), with Workers Static Assets for the three pages and one Durable Object class, `CarRelay`. Configured in [`wrangler.jsonc`](../wrangler.jsonc).

**Why not Pages + Functions:** Cloudflare's Pages-to-Workers migration guide says Pages cannot define a Durable Object itself: "you must create a separate Worker with a Durable Object … Using Durable Objects with Workers is simpler and recommended" ([source](https://github.com/cloudflare/cloudflare-docs/blob/0d6b59726ff1ac17417e9840e4aa5af799ea89b0/src/content/docs/workers/static-assets/migration-guides/migrate-from-pages.mdx#L487), public page: *Migrate from Pages to Workers*). That would be two deployables for one site. Pages brought nothing this site needs.

**SQLite-backed Durable Object.** The Free plan "can only create and access SQLite-backed Durable Objects" ([source](https://github.com/cloudflare/cloudflare-docs/blob/0d6b59726ff1ac17417e9840e4aa5af799ea89b0/src/content/partials/durable-objects/durable-objects-pricing.mdx)), hence `new_sqlite_classes` in the migration. The relay stores nothing; alarms are its only use of storage.

**No `workers.dev` or preview URL.** `workers_dev: false` and `preview_urls: false`. Either would reach the Worker without passing Cloudflare Access, and then `Cf-Access-Authenticated-User-Email` — the only source of `X-Racerbot-User` — could be typed by anyone. See [security.md](security.md).

## Deploying: Cloudflare builds from the repo (Workers Builds)

**Decision (2026-09-27):** the site is deployed by connecting this repo to the Worker in the Cloudflare dashboard, not from GitHub Actions. Cloudflare runs `npm run build` then `npx wrangler deploy` on every push to `main`. The GitHub workflow keeps running the tests, a Lichtblick build, the asset check and a dry-run deploy, as checks, and holds no secrets.

**It fits.** The free build machine has 2 vCPU, 8 GB of memory, 20 GB of disk and a 20-minute limit, with 3,000 build minutes a month ([source](https://github.com/cloudflare/cloudflare-docs/blob/0d6b59726ff1ac17417e9840e4aa5af799ea89b0/src/content/docs/workers/ci-cd/builds/limits-and-pricing.mdx)). The Lichtblick build took about 2 minutes on GitHub's runner and 3 locally.

**Things the setup has to get right:**
- The Worker's name in the dashboard must equal `name` in `wrangler.jsonc` (`racerbot-dashboard`) or the build fails ([source](https://github.com/cloudflare/cloudflare-docs/blob/0d6b59726ff1ac17417e9840e4aa5af799ea89b0/src/content/docs/workers/ci-cd/builds/index.mdx#L44-L48)).
- Runtime secrets go under **Variables and Secrets**; the **Build variables and secrets** section is build-time only ([source](https://github.com/cloudflare/cloudflare-docs/blob/0d6b59726ff1ac17417e9840e4aa5af799ea89b0/src/content/docs/workers/ci-cd/builds/configuration.mdx)).
- Preview builds are turned off: the site has no preview URLs, since they would skip Access.
- The build image preinstalls Node 22 and 24 and its own Yarn ([source](https://github.com/cloudflare/cloudflare-docs/blob/0d6b59726ff1ac17417e9840e4aa5af799ea89b0/src/content/docs/workers/ci-cd/builds/build-image.mdx)). `.nvmrc` pins Node 22, and `apps/advanced/build.sh` puts corepack's Yarn shims first on `PATH` in a folder it owns, so Lichtblick gets its pinned Yarn whatever the image has.

**Verified:** the GitHub workflow's build job passed on its first run (Lichtblick v1.29.1 built from source, asset check, dry-run deploy). A real Workers Builds run needs the dashboard connection, step 5 of [cloudflare-setup.md](cloudflare-setup.md).

## Routing

**How the Worker runs first for dynamic routes:** Static Assets serves a file when one matches, and invokes the Worker when none does ([source](https://github.com/cloudflare/cloudflare-docs/blob/0d6b59726ff1ac17417e9840e4aa5af799ea89b0/src/content/docs/workers/static-assets/routing/worker-script.mdx), public page: *Worker script*). None of `/`, `/api/cars` or `/<car>/…` is a file in `dist/`, so all of them reach the Worker without `run_worker_first`. `run_worker_first` accepts an array of glob patterns with `!` negation ([source](https://github.com/cloudflare/cloudflare-docs/blob/0d6b59726ff1ac17417e9840e4aa5af799ea89b0/src/content/docs/workers/static-assets/binding.mdx#L95-L127)) — it is not needed here, and leaving it off keeps direct asset paths free of Worker invocations.

**`html_handling: "none"`.** The default (`auto-trailing-slash`) redirects `/simple/index.html` to `/simple/`. Behind the Worker's rewrite from `/rb2/simple/` that redirect would drop the `/rb2` prefix. With `none`, the Worker maps a trailing slash to `index.html` itself ([`routes.ts`](../worker/src/routes.ts)).

**Every page asset request under `/<car>/…` is a Worker invocation**, because the Worker maps `/rb2/simple/x` to the asset `/simple/x`. That counts against the 100,000 requests a day of the Free plan; a page load is about eight requests for the simple dashboard and a few dozen for Lichtblick. See [costs.md](costs.md).

## Static asset limits, and the Lichtblick build

**Limits:** 20,000 files per Worker version on Free (100,000 on Paid), 25 MiB per file on both ([source](https://github.com/cloudflare/cloudflare-docs/blob/0d6b59726ff1ac17417e9840e4aa5af799ea89b0/src/content/docs/workers/platform/limits.mdx#L34-L35), public page: *Workers limits*).

**Measured, Lichtblick v1.29.1 `web:build:prod`:** 403 files, 168.8 MiB. Largest:

| Size | File |
|---|---|
| 21.16 MiB | `3482.*.js.map` (source map) |
| 18.46 MiB | `ts.worker.*.js.map` (source map) |
| 17.09 MiB | `3420.*.js.map` (source map) |
| 6.79 MiB | `ts.worker.*.js` — largest file actually deployed |
| 6.44 MiB | `3420.*.js` |

**Source maps are not deployed.** They are only fetched by an open developer console, they are 128 MiB of the 169, and they are the files closest to the 25 MiB limit. Deployed: `dist/` is 219 files, 41.3 MiB.

**The check:** [`scripts/assemble.mjs`](../scripts/assemble.mjs) prints the largest Lichtblick output files (maps included, marked) and the largest deployed files, and exits non-zero naming any deployed file over 25 MiB or a total over 20,000 files. CI runs it on every pull request.

## Proxying WebSockets from the Worker

**How:** a `fetch()` to the origin with the browser's `Upgrade: websocket` header returns a response carrying a `webSocket`. Returning that response to the browser hands the socket over and the runtime joins the two ends ([source](https://github.com/cloudflare/cloudflare-docs/blob/0d6b59726ff1ac17417e9840e4aa5af799ea89b0/src/content/docs/workers/examples/websockets.mdx), section *Write a WebSocket client*: "call `accept()` to indicate that you'll be handling the socket here … as opposed to returning it on to a client"). Used for `/control` and `/bridge` ([`proxy.ts`](../worker/src/proxy.ts)). The car's `Sec-WebSocket-Protocol` answer comes back with it, which is how `foxglove.sdk.v1` negotiation survives the proxy.

**Exercised:** `wrangler dev` + mock car for `/control`, and headless Chromium running Lichtblick through `/rb2/bridge` against a stand-in bridge that accepts only `foxglove.sdk.v1` (it connected, and saw `X-Racerbot-User`, the service token, and no role).

**Why no JavaScript in the data path.** The Free plan allows **10 ms of CPU per HTTP request**, and a WebSocket is one request for its whole life ([source](https://github.com/cloudflare/cloudflare-docs/blob/0d6b59726ff1ac17417e9840e4aa5af799ea89b0/src/content/docs/workers/platform/limits.mdx#L67-L75)). Copying frames in JavaScript would spend CPU on every frame of a Lichtblick session, which runs out in seconds. With a passthrough the Worker spends CPU on the handshake only. Messages through a Worker are not billed as requests either ([source](https://github.com/cloudflare/cloudflare-docs/blob/0d6b59726ff1ac17417e9840e4aa5af799ea89b0/src/content/docs/workers/platform/pricing.mdx), footnote 2: "WebSocket messages routed through a Worker do not count as requests").

**Consequence for bridge logging.** With no JavaScript in the path, the Worker never sees the socket close. So `bridge_connect` is logged as `{user, car, connected_at, disconnected_at: null, close_code: null, tracking: "native"}`. Setting `BRIDGE_TRACKING=relay` copies frames through the Worker instead (`accept({ allowHalfOpen: true })` on both sockets, [docs](https://github.com/cloudflare/cloudflare-docs/blob/0d6b59726ff1ac17417e9840e4aa5af799ea89b0/src/content/docs/workers/examples/websockets.mdx#L346-L352)) and logs `bridge_disconnect` with both fields — verified locally, close code 1001 recorded. Use it only on Workers Paid (default CPU limit 30 s per request, raisable to 5 min). Bridge messages are never inspected in either mode.

## The relay's own WebSocket to the car

**How:** `fetch(dash_origin + "/ws?role=relay", { headers: { Upgrade: "websocket", … } })`, then `resp.webSocket.accept()` ([source](https://github.com/cloudflare/cloudflare-docs/blob/0d6b59726ff1ac17417e9840e4aa5af799ea89b0/src/content/docs/workers/examples/websockets.mdx), *Write a WebSocket client*). This form, unlike `new WebSocket(url)`, can carry the service-token and role headers.

**`binaryType = "arraybuffer"` before `accept()`.** From compatibility date 2026-03-17, binary frames arrive as `Blob` by default ([source](https://github.com/cloudflare/cloudflare-docs/blob/0d6b59726ff1ac17417e9840e4aa5af799ea89b0/src/content/docs/workers/runtime-apis/websockets.mdx#L231-L256)). The relay only measures and forwards them, and `ArrayBuffer` is the form it can do both with.

**Origin.** The relay has no browser behind it, so it sends `Origin: <PUBLIC_ORIGIN>` (`https://dashboard.sfuracerbot.ca`), which the car allows. `/control`, `/bridge` and `/camera` pass the browser's own Origin through unchanged.

**It keeps the object in memory.** "Hibernation is only supported when a Durable Object acts as a WebSocket server. Outgoing WebSockets do not hibernate" ([source](https://github.com/cloudflare/cloudflare-docs/blob/0d6b59726ff1ac17417e9840e4aa5af799ea89b0/src/content/docs/durable-objects/best-practices/websockets.mdx#L315-L319)). That is the intended trade: the relay is billed for duration exactly while it holds the car connection, which is while someone is watching plus the idle grace period. An outbound connection only protects the object from eviction for 15 minutes ([source](https://github.com/cloudflare/cloudflare-docs/blob/0d6b59726ff1ac17417e9840e4aa5af799ea89b0/src/content/docs/durable-objects/concepts/durable-object-lifecycle.mdx#L67-L74)), but the car sends about 40 messages a second, each an event, so the object is never idle long enough to be evicted while connected.

## Keeping the relay asleep when nobody watches

- **Viewer sockets use the Hibernation API** (`ctx.acceptWebSocket`), so a relay with viewers and no car link — the car is off — can be evicted between reconnect attempts.
- **Timers are alarms, not `setTimeout`.** `setTimeout`/`setInterval` prevent hibernation ([source](https://github.com/cloudflare/cloudflare-docs/blob/0d6b59726ff1ac17417e9840e4aa5af799ea89b0/src/content/docs/durable-objects/best-practices/websockets.mdx#L319)); an alarm wakes an evicted object, and `ctx.id.name` is available in the alarm handler when the object was reached with `getByName` ([source](https://github.com/cloudflare/cloudflare-docs/blob/0d6b59726ff1ac17417e9840e4aa5af799ea89b0/src/content/docs/durable-objects/api/id.mdx#L83-L93)). There is one alarm, set to whichever is due first of *reconnect* and *idle close*, and deleted when neither is.
- **With zero viewers:** the car connection closes after `UPSTREAM_IDLE_SEC` (default 60), the cache is cleared and the alarm deleted. No outbound socket, no alarm, no viewers: nothing holds the object. Verified in `wrangler dev` (log: `upstream_disconnect … "reason":"idle"`, exactly the configured 10 s after the last viewer left).
- **Heartbeat without waking it:** the page sends `{"type":"relay_ping"}` every 10 s and the runtime answers `{"type":"relay_pong"}` itself via `setWebSocketAutoResponse`, which "will not incur additional wall-clock time" ([source](https://github.com/cloudflare/cloudflare-docs/blob/0d6b59726ff1ac17417e9840e4aa5af799ea89b0/src/content/partials/durable-objects/durable-objects-pricing.mdx), footnote 3).

## Slow and dead viewers

**What the runtime offers.** `ws.send()` returns at once. workerd keeps a separate outgoing-message queue and pump per socket ([workerd `web-socket.h`](https://github.com/cloudflare/workerd/blob/1481f440b0dc69fee8dcfd2e1995fac5f88f2f88/src/workerd/api/web-socket.h#L898-L900)), so one slow viewer's backlog cannot delay another's. There is no `bufferedAmount` and no backpressure signal; the runtime API reference documents `send()` and nothing about its queue ([source](https://github.com/cloudflare/cloudflare-docs/blob/0d6b59726ff1ac17417e9840e4aa5af799ea89b0/src/content/docs/workers/runtime-apis/websockets.mdx)).

**What that leaves.** A viewer that has silently vanished (a phone that left WiFi without closing the socket) would accumulate telemetry forever in memory. So the relay uses the heartbeat: `getWebSocketAutoResponseTimestamp(ws)` says when each viewer last pinged, and while traffic flows the relay closes (code 4000) any viewer that pinged before but not for 45 s. At the car's ~57 kB/s that caps one dead viewer's backlog at about 2.5 MB. A client that never pings (an old page, a script) is not culled.

**Keeping pairs together.** Each unit (a header, or a header plus its binary) is sent to one viewer completely before the next viewer; if a send throws, that viewer is closed so it reconnects and resynchronises, the same stance the car takes ([car `_send_to_all`](https://github.com/sfu-racerbot/Racerbot-Car-2-Workspace/blob/022e6faac95bbb4875939ed5f411c80ebcf92ab4/src/web_dashboard/web_dashboard/dashboard_node.py#L1852-L1877)).

## MJPEG through the Worker and the tunnel

**The Worker half.** Workers stream a response body as it arrives when it is passed through unmodified ([source](https://github.com/cloudflare/cloudflare-docs/blob/0d6b59726ff1ac17417e9840e4aa5af799ea89b0/src/content/docs/workers/runtime-apis/streams/index.mdx#L19-L25)). An HTTP-triggered Worker has no duration limit while the client stays connected ([source](https://github.com/cloudflare/cloudflare-docs/blob/0d6b59726ff1ac17417e9840e4aa5af799ea89b0/src/content/docs/workers/platform/limits.mdx#L152-L163)), and waiting on a subrequest is not CPU time. `/camera/*` returns the origin's response as-is ([`proxy.ts`](../worker/src/proxy.ts)). **Exercised:** through `wrangler dev`, `curl` received the mock's `multipart/x-mixed-replace` stream continuously at ~10 frames/s with `Transfer-Encoding: chunked`, and Chromium showed it in the inset.

**The tunnel half.** cloudflared flushes every write for any response without a `Content-Length` (a stream), for chunked transfer encoding, and for SSE/gRPC types ([cloudflared `connection.go` `shouldFlush`](https://github.com/cloudflare/cloudflared/blob/f9676c585623c86c0a48dbb6ae80840b4c834718/connection/connection.go#L299-L325)). The car's camera node sends no `Content-Length` on `/stream`, so it is flushed frame by frame. Over QUIC (cloudflared's default) the adapter's `Flush()` is a no-op because nothing is buffered to begin with ([`quic_connection.go`](https://github.com/cloudflare/cloudflared/blob/f9676c585623c86c0a48dbb6ae80840b4c834718/connection/quic_connection.go#L330)).

**Not yet seen end to end** through a real tunnel and the Cloudflare edge — that needs the car. See [Still unverified](#still-unverified).

## What the relay remembers for late joiners

The car catches each new connection up in `send_initial_state` ([car source](https://github.com/sfu-racerbot/Racerbot-Car-2-Workspace/blob/022e6faac95bbb4875939ed5f411c80ebcf92ab4/src/web_dashboard/web_dashboard/dashboard_node.py#L1879-L1926)). The car now has one connection — the relay — so the relay does that job for every later viewer. The list comes from that function, from the `_broadcast` call sites, and from the car's README.

| Type | Sent by the car | Relay |
|---|---|---|
| `hello` | first message on every connection (new contract) | latest, replayed **first** |
| `map` + `map_patch` | keyframe on connect, on resize, every `map_keyframe_sec`; patches carry `seq` | latest keyframe + every patch since, in seq order; reset on each keyframe |
| `scan` | 10 Hz; latest to new connections | latest header + binary |
| `pose`, `drive`, `speed`, `intent`, `stopwatch`, `stats` | inside 20 Hz `batch` frames; latest to new connections | unpacked from batches; latest of each, replayed as standalone messages, as the car does |
| `racing_line` | on change (latched topic); to new connections | latest |
| `tuning`, `processes`, `saved_maps` | whole-panel snapshot on change; to new connections | latest |
| `tuning_armed` | per connection | **not forwarded** (see the top of this file) |
| `map_cleared` | per connection, answer to "clear view" | not cached; the relay answers "clear view" itself |
| `tuning_result`, `tuning_saved`, `process_result`, `map_delete_result`, `slam_reset_result` | events, broadcast | forwarded live, never replayed |

**Replay order** is the car's own: `hello`, map, scan, pose, drive, speed, intent, racing_line, stats, stopwatch, tuning, processes, saved_maps. It is preceded by one `relay_status`.

**The map cache is capped at 16 MiB** (header text plus binary bytes). A keyframe is about 24 kB deflated, 4 MB uncompressed at 2048×2048; a patch is about 200 bytes. On overflow, or on a `seq` gap, the whole chain is dropped until the next keyframe. A viewer joining in that window gets no map and shows "no map yet"; the page's `seq` check then accepts the next keyframe. (The page's "waiting for a keyframe" message appears when it holds a map and a patch doesn't follow it; with no map at all it ignores patches silently — see `applyMapPatch`.)

**Why `relay_status`.** Every relay-originated type starts with `relay_` (`relay_status`, `relay_error`, `relay_ping`, `relay_pong`). No car type does, and a unit test fails if one ever appears in the relay's list of car types.

**Framing.** A header with a numeric top-level `bytes` field is followed by exactly one binary frame of that length (today `map`, `map_patch`, `scan`; `saved_maps` has `bytes` only inside its `runs`). The relay parses headers only, checks each binary's length against its header, never decodes a payload, and forwards each pair as one unit ([`framing.ts`](../worker/src/framing.ts)).

## The car contract, as built

What the car session has to match (and what [`tools/mock-car`](../tools/mock-car) implements):

| | Relay (`/ws?role=relay`) | Control (`/ws?role=control`) |
|---|---|---|
| Opened by | the `CarRelay` Durable Object, once per car | the Worker, once per browser tab that writes |
| Headers | `CF-Access-Client-Id`, `CF-Access-Client-Secret`, `X-Racerbot-Role: relay`, `Origin: https://dashboard.sfuracerbot.ca` | the same token, `X-Racerbot-Role: control`, `X-Racerbot-User: <email>`, the browser's `Origin` and `Sec-WebSocket-*` |
| First message | `{"type":"hello","protocol_version":N}` | same |
| Then | the full stream, as today | tuning, `tuning_armed`, processes, saved runs, stopwatch, and replies |
| Writes | all refused | work as today; arming is per connection |

The role travels twice, as `?role=` and as `X-Racerbot-Role`. The header is the one a browser cannot set (the Worker deletes any it sends); the mock prefers the header and falls back to the query for a page pointed straight at it.

Camera requests carry the token and `X-Racerbot-User`; bridge requests carry the token and `X-Racerbot-User`; neither carries a role. Every request first loses any `X-Racerbot-*`, `CF-Access-Client-*`, `Cookie`, `Authorization` and `Cf-Access-*` header the browser sent ([`headers.ts`](../worker/src/headers.ts), with tests).

The WebSocket path on the car is `/ws` ([car `make_app`](https://github.com/sfu-racerbot/Racerbot-Car-2-Workspace/blob/022e6faac95bbb4875939ed5f411c80ebcf92ab4/src/web_dashboard/web_dashboard/dashboard_node.py#L1932-L1939)).

## The simple dashboard's changes

Only the changes the new URLs and sockets require; everything else is in [follow-ups.md](follow-ups.md).

- **Telemetry** from `wss://<host>/<car>/ws`, the car taken from the first path segment (`resolveEndpoints` in `dashboard.js`, tested).
- **Writes** — tuning arm/set/save, process stop, map delete, SLAM reset, stopwatch enable/reset — go through one function, `sendControl`, over `/<car>/control`. It opens on the first write, closes after `CONTROL_IDLE_MIN` (5) minutes without a write and immediately when the tab is hidden, and its close disarms the tuning panel. Only writes count as activity: an armed panel with a chatty car still closes.
- **"Clear view" stays on the telemetry socket.** The relay answers it from the map it holds, exactly as the car used to (`map_cleared`, then the keyframe and patches). Sending it over `/control` would need the car's control role to send map frames, which the contract says it doesn't.
- **`tuning_armed` is read from the control link only.**
- **Binary-carrying headers on the control link are dropped** so they can never claim the telemetry socket's single "next binary" slot.
- **Camera** at `/<car>/camera/stream?tier=preview|full` on the page's own origin, in both the inset and `camera.html`, keeping the 3 s retry with a cache-busting parameter.
- **Local overrides** `?ws=`, `?control=`, `?camera=` are honoured only when the page is served over `http://` from `localhost`/`127.0.0.1`/`[::1]`.
- **Protocol:** `SUPPORTED_PROTOCOL_VERSION = 1`. The first car message on a connection decides: `hello` gives its version; anything else means version 0, a pre-migration car, which is accepted. Any other mismatch turns the link row red and puts "this car runs protocol N, this site expects M: update the car or redeploy the site" in the mode banner, above even the frame-desync warning. The page keeps working.
- **The link row** (`#link-detail`) is one fixed-height line under the connection state: a dot (relay has the car / not / unknown), `car online · 2 watching`, and `ctl open`/`ctl idle`. It never changes height; long text is clipped with the full detail in its tooltip. On a phone it sits in the sheet's peek, under the connection line (checked at 390×844 in Chromium).
- **Heartbeat:** `{"type":"relay_ping"}` every 10 s on the telemetry socket, from both pages.

## Lichtblick: tag, subpath, deep link, layout

**Tag: `v1.29.1`** (2026-09-08, the newest release when this was built), pinned in [`apps/advanced/LICHTBLICK_VERSION`](../apps/advanced/LICHTBLICK_VERSION).

- **Speaks the SDK bridge's subprotocol.** The player offers `[FoxgloveClient.SUPPORTED_SUBPROTOCOL, "foxglove.sdk.v1"]` ([source at v1.29.1](https://github.com/lichtblick-suite/lichtblick/blob/v1.29.1/packages/suite-base/src/players/FoxgloveWebSocketPlayer/index.ts#L190)). That landed in [f798c47](https://github.com/lichtblick-suite/lichtblick/commit/f798c4728fccf8a1e225995212a5c274d1694cdd), "Add support for foxglove.sdk.v1 WebSocket subprotocols (reopened #772) (#819)", first released in v1.22.1. Any tag from v1.22.1 on would do; the newest was taken for its other fixes. **Exercised:** Chromium connected through the Worker to a stand-in bridge that accepts only `foxglove.sdk.v1`.
- **Builds from source** with `corepack enable; yarn install --immutable; yarn run web:build:prod` into `web/.webpack` (it built here in 71 s; see [`apps/advanced/build.sh`](../apps/advanced/build.sh)).

**Subpath: works as built, no override needed.** The production webpack config uses `publicPath: "auto"` ([source](https://github.com/lichtblick-suite/lichtblick/blob/v1.29.1/packages/suite-web/src/webpackConfigs.ts#L138-L141)), so chunks load relative to the script that asked for them, and the generated `index.html` references its script, icons and styles by relative path. **Exercised:** served at `/rb2/advanced/` through `wrangler dev`, it loaded with no failed requests in headless Chromium. So no second hostname, and no extra DNS or Access steps.

**Deep link: supported.** `?ds=foxglove-websocket&ds.url=<wss url>` is parsed by `parseAppURLState` ([source](https://github.com/lichtblick-suite/lichtblick/blob/v1.29.1/packages/suite-base/src/util/appURLState.ts#L88-L121)) and opened on startup by `Workspace.tsx`; `foxglove-websocket` is the data source id ([source](https://github.com/lichtblick-suite/lichtblick/blob/v1.29.1/packages/suite-base/src/dataSources/FoxgloveWebSocketDataSourceFactory.ts)). The landing page builds `ds.url` from its own origin. **Exercised:** it auto-connected.

**Team default layout, without a fork.** `index.html` contains `globalThis.LICHTBLICK_SUITE_DEFAULT_LAYOUT = [/*LICHTBLICK_SUITE_DEFAULT_LAYOUT_PLACEHOLDER*/][0]`, which Lichtblick's own Docker image fills from a mounted file ([Dockerfile](https://github.com/lichtblick-suite/lichtblick/blob/v1.29.1/Dockerfile)). `assemble.mjs` fills it with [`racerbot-default.json`](../apps/advanced/layouts/racerbot-default.json). It is the layout a browser gets **when it has no layout of its own yet**; Lichtblick keeps a user's layouts in that browser. Panel titles use the key `lichtblickPanelTitle` ([source](https://github.com/lichtblick-suite/lichtblick/blob/v1.29.1/packages/suite-base/src/util/layout.ts#L49)). **Exercised:** all six panels appear.

**Chrome or Edge.** The web build checks for `Chrome/<n>` in the user agent (Edge's includes it) and shows a compatibility banner otherwise ([source](https://github.com/lichtblick-suite/lichtblick/blob/v1.29.1/packages/suite-web/src/index.tsx#L47-L57); minimum Chrome 76 in `CompatibilityBanner.tsx`). The landing page says so.

## Cloudflare Access details

- **The user's email** reaches the Worker as `Cf-Access-Authenticated-User-Email` on requests Access has let through ([tutorial source](https://github.com/cloudflare/cloudflare-docs/blob/0d6b59726ff1ac17417e9840e4aa5af799ea89b0/src/content/docs/cloudflare-one/tutorials/access-workers.mdx#L44-L77)). With Static Assets the Worker does not get `ctx.access` ([source](https://github.com/cloudflare/cloudflare-docs/blob/0d6b59726ff1ac17417e9840e4aa5af799ea89b0/src/content/docs/workers/static-assets/routing/worker-script.mdx)); the header is what it uses. With no email, `/control`, `/bridge` and `/camera` answer 403 (except in `wrangler dev` with `ALLOW_ANONYMOUS_DEV=1`).
- **Service tokens** are sent as `CF-Access-Client-Id` / `CF-Access-Client-Secret`, and the Access app's policy must use the **Service Auth** action or Access sends the request to a login page instead ([source](https://github.com/cloudflare/cloudflare-docs/blob/0d6b59726ff1ac17417e9840e4aa5af799ea89b0/src/content/docs/cloudflare-one/access-controls/service-credentials/service-tokens.mdx#L33-L55)). New secrets (from 2026-08-26) look like `cfast_…`.
- **Binding cookie off**, as asked. With it on, `CF_Authorization` is rejected without its paired `CF_Binding` cookie ([source](https://github.com/cloudflare/cloudflare-docs/blob/0d6b59726ff1ac17417e9840e4aa5af799ea89b0/src/content/docs/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/index.mdx#L130-L135)). Nothing here needs it, and it is one more way for a WebSocket upgrade or `<img>` request to be refused.

## Zone security rules and the Worker's own requests

**Found in use (2026-09-27):** a zone-wide WAF bot challenge stopped the Worker reaching the car. Cloudflare runs a Worker's subrequests to the same zone through that zone's rules ([WAF docs](https://github.com/cloudflare/cloudflare-docs/blob/0d6b59726ff1ac17417e9840e4aa5af799ea89b0/src/content/docs/waf/rate-limiting-rules/troubleshooting.mdx#L16-L24), which exclude them with `cf.worker.upstream_zone`). A challenge page carries `cf-mitigated: challenge` ([docs](https://github.com/cloudflare/cloudflare-docs/blob/0d6b59726ff1ac17417e9840e4aa5af799ea89b0/src/content/docs/cloudflare-challenges/challenge-types/challenge-pages/detect-response.mdx#L14-L20)), which `/<car>/check`, the relay's error and the passthroughs' 502 now recognise. Fix: [cloudflare-setup.md](cloudflare-setup.md), section "If your zone has a WAF challenge rule".

This also settles the earlier open question below: same-zone Worker subrequests *do* pass through the zone's security features, so they pass through the origins' Access applications too, and the service token is what admits them.

## Still unverified

Each needs the real car, the real zone or a real deploy:

- **MJPEG through a real tunnel and the Cloudflare edge.** Both halves are verified separately (workerd locally; cloudflared by source). Check on first deploy: the camera inset should update smoothly, not in bursts.
- **Whether messages the relay *receives* on its outbound car connection are billed as "incoming WebSocket messages".** The pricing footnote does not distinguish server from client sockets. [costs.md](costs.md) assumes they are (the expensive reading).
- **That Access strips a browser-supplied `Cf-Access-Authenticated-User-Email`** before the Worker sees it. Believed true; the header is set by Access after authentication. Worth checking once with `curl -H` on the live site. JWT validation would remove the dependency ([follow-ups.md](follow-ups.md)).
- ~~**Whether a Worker's `fetch()` to another hostname in the same zone passes through that hostname's Access application.**~~ Settled: it does (see the WAF section above). The docs found here do not say. Either way only the Worker gets in: if Access applies, the service token admits it; if it does not, the request never left Cloudflare. The setup doc's `curl` check (expecting 401 from outside) is what proves the origins are closed to everyone else.
- **The car's side of the contract** — its role handling, `hello`, and Origin allow-list — is being built by the car session and has only been matched against the mock.
- **Two Lichtblick layout topics** could not be confirmed from the car repo: the compressed camera topic, and whether the car runs foxglove_bridge at all yet (nothing in the car repo mentions it). See [`apps/advanced/README.md`](../apps/advanced/README.md).
