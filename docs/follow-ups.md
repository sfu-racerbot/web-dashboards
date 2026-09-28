# Follow-ups

> **Who this is for:** whoever picks up the next piece of work on this repo.
> **Read first:** [decisions.md](decisions.md) for why things are the way they are now.
> **What's in it:** changes deliberately left out of the first build, mostly because the brief limited the simple dashboard to the changes the move required.

Each item says what, why, and roughly how big.

## The simple dashboard

1. **The recording view's overlay freezes after its first second.** `camera.js` handles only top-level `speed`, `drive`, `stats` and `stopwatch` messages. Since the car started batching telemetry, those arrive inside `batch` frames, so it only ever sees the catch-up copies sent on connect.

   Fix: unpack `batch` the way `dashboard.js`'s `handleHeader` does. This bug predates the move (it is in the car repo at `022e6fa`). Small.
2. **Back off the camera retry.** The inset retries every 3 s while the camera is off, which is a Worker request each time: 1,200 an hour per open tab, 28,800 a day, against a free limit of 100,000 ([costs.md](costs.md)). Doubling up to 60 s would cut that to under 100 an hour. Small.
3. **A favicon.** Every page load asks for `/favicon.ico` and gets a 404 (one wasted Worker request). Small.
4. **Show `relay_error` somewhere a person sees it.** Today it goes to the console only. Nothing the page sends should trigger it, so it only matters to someone writing a new feature. Small.
5. **Share `resolveEndpoints` between `dashboard.js` and `camera.js`.** It is duplicated so neither page gains a script tag (the script order is pinned by a test). A shared `endpoints.js` would need that test updated on purpose. Small.
6. **Say "waiting for a keyframe" when a late joiner arrives with no map.** If the relay dropped its map cache (over 16 MiB, or a seq gap), a new tab shows "no map yet" until the next keyframe, up to 30 s. Accurate, but it could say why. Small.

## The relay and the Worker

7. **Validate the Access JWT** (`Cf-Access-Jwt-Assertion`) against the team's certs instead of trusting `Cf-Access-Authenticated-User-Email` alone. Today a mistake that exposed the Worker without Access would make the email forgeable; with JWT validation it would fail closed. Medium: needs the team domain and application AUD as config.
8. **Per-user permissions for writes.** Everyone on the Access list can arm tuning and delete maps. A second, shorter list for write actions, checked in the Worker on `/control`, would separate watchers from operators. Medium.
9. **Car protocol v2** (header and binary in one frame) and a lower `telemetry_rate_hz`. Car-side changes; see [costs.md](costs.md) for what each saves. The relay's framing would need a v2 path.
10. **Record measured costs.** After a week of real use, replace the assumption in [costs.md](costs.md) about whether messages the relay receives are billed, using the Durable Objects metrics.

## Lichtblick

11. **Confirm the compressed camera topic** and fix the Image panel in [`apps/advanced/layouts/racerbot-default.json`](../apps/advanced/layouts/racerbot-default.json). See [`apps/advanced/README.md`](../apps/advanced/README.md) for every TODO.
12. **Add the particle filter's particle cloud** to the 3D panel once its topic name is confirmed.
13. **Watch for new Lichtblick releases.** Bumping is one line in `LICHTBLICK_VERSION`; CI rebuilds and re-checks the asset limits.
