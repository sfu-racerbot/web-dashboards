# Mock car

> **Who this is for:** anyone working on the dashboards without a car to hand.
> **Read first:** [../../README.md](../../README.md), "Local development".
> **You'll be able to:** run the whole site locally — landing page, simple dashboard, relay, control link and camera — against a pretend car.
> **Time:** two minutes.

A Node program that answers the way the car does: the same WebSocket protocol as the car's `dashboard_node`, the same two roles, and an MJPEG camera. It prints how many messages a second it sends, which is the number [docs/costs.md](../../docs/costs.md) is built on.

## Highlights

- **The car's real ports.** `dashboard_node` on 8080 (`/ws`), the camera on 9090 (`/stream`), so `.dev.vars.example` points at it unchanged.
- **The real stream shapes.** A `hello`, a deflated map keyframe with `seq`, patches that follow it (and a keyframe every 30 s), u16 millimetre scans at 10 Hz ray-cast against a track, and 20 Hz batches of pose, command, speed, intent, stopwatch and stats. `bytes` always matches the binary that follows.
- **Both roles.** `relay` gets the stream and has every write refused; `control` gets only the panels' state and replies, and arming is per connection.
- **Working panels.** A fake tuning catalogue for `pure_pursuit_node` and `gap_follow_node`, a process list with a protected `ackermann_mux`, two saved runs you can delete by typing their names, and a SLAM reset that really clears the map.
- **Honest limits.** No foxglove_bridge (so `/<car>/bridge` answers 502, correctly), no real physics, and it accepts any service token.

## Running it with the site

**Run these in order.** Both terminals from the repo root.

**Terminal 1** — the mock car. Leave it running.

```bash
npm run mock
```

**Working when:** it prints `dashboard_node on ws://localhost:8080/ws?role=relay|control, camera on http://localhost:9090/stream`.

**Terminal 2** — the site, with its relay, pointed at the mock.

```bash
cp .dev.vars.example .dev.vars   # first time only
npm run dev
```

**Working when:** it prints `Ready on http://localhost:8787`. Open that address, then **Simple**.

**If it doesn't:** a `502 car rb2 unreachable` means Terminal 1 is not running, or something else holds port 8080.

## What to look for

| In the browser | In Terminal 1 |
|---|---|
| The map draws itself as the car drives round; the camera shows a moving bar | `+ relay connection (… service token present, origin http://localhost:8787)` |
| A second tab shows the same map at once | still **one** relay connection |
| Enabling the stopwatch or arming tuning makes the link row say `CTL OPEN` | `+ control connection (user dev@localhost …)` then `dev@localhost: tuning_control/arm` |
| Close every tab | 10 s later: `- relay connection closed (1000)` — the relay's idle close |

Every 5 s it prints a `[rates]` line: messages per second per connection for each role, how many were binary, kB/s, and camera frames per second.

## Options

Pass them after `node tools/mock-car/server.mjs` (or after `npm run mock --`).

| Option | Default | What it does |
|---|---|---|
| `--port` | `8080` | `dashboard_node`'s port |
| `--camera-port` | `9090` | the camera's port |
| `--protocol N` | `1` | the `protocol_version` in `hello`. Try `2` to see the mismatch banner |
| `--no-hello` | off | send no `hello`, like a car from before protocol versioning (version 0; no banner) |
| `--keyframe-sec` | `30` | how often a full map keyframe goes out |
| `--allow-origin` | the site and `localhost:8787` | Origins accepted, as the real car checks them. Repeatable |
| `--quiet` | off | no log lines (the tests use this) |

## Pointing the page straight at the mock

Useful for working on the page without the Worker. Serve `apps/simple/web/` on any localhost port, and override the three URLs — the page only honours these on `http://localhost`:

```
http://localhost:5500/?ws=ws://localhost:8080/ws?role%3Drelay&control=ws://localhost:8080/ws?role%3Dcontrol&camera=http://localhost:9090
```

Add your port's origin with `--allow-origin http://localhost:5500`. There is no relay in between, so the link row stays at `relay --`.

## Tests

**Terminal 1**, from the repo root:

```bash
npm run test:mock
```

**Working when:** it ends with `# pass 9` and `# fail 0`. The tests start the real server on spare ports and check the contract: `hello` first, header/binary pairs intact, seq order, writes refused on relay, no stream on control, arming per connection, and a working MJPEG stream.

## Files

| File | What it is |
|---|---|
| `server.mjs` | Sockets, timers and the rate printout |
| `car.mjs` | What each role gets and what each write action does |
| `world.mjs` | The track, the car's motion, the LiDAR ray-cast, the "SLAM" reveal and the map keyframes/patches |
| `mjpeg.mjs` | The camera: JPEG frames drawn and encoded on the fly |
