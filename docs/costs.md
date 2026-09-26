# What the dashboards cost to run

> **Who this is for:** whoever pays the Cloudflare bill, or wants to know how many hours of watching the free plan allows.
> **Read first:** [../README.md](../README.md), for what the relay is.
> **What's in it:** the free-plan limits that matter, the measured message rate, viewing hours per day, when Workers Paid is worth $5 a month, and what a protocol change would save.

**The short version:** on the Workers Free plan the site allows about **13 hours of watching a car per day**, however many people watch at once.

The limit that runs out first is Durable Object requests (the relay's), because every message the car sends into the relay counts as one twentieth of a request.

Workers Paid includes about 130 hours a month, then costs roughly **$0.007 per extra hour**.

## Highlights

- **Viewers are free; watching time is not.** Ten people watching one car costs the same as one: the car sends each message once, to the relay, which fans it out. Messages the relay sends out are not billed.
- **Nothing is billed while nobody watches.** The relay drops the car connection 60 s after the last viewer leaves and goes to sleep.
- **Lichtblick and the camera cost almost nothing to proxy.** They pass through with no Worker code in the data path: one request per connection, however long it lasts.
- **The limit is a daily one on Free.** Past it, requests fail with an error until 00:00 UTC. It does not bill you; it stops.

## The limits that matter

| Free plan limit | Value | Source |
|---|---|---|
| Durable Object requests | 100,000 / day; **incoming WebSocket messages count at 20:1**, outgoing ones are free | [DO pricing](https://github.com/cloudflare/cloudflare-docs/blob/0d6b59726ff1ac17417e9840e4aa5af799ea89b0/src/content/partials/durable-objects/durable-objects-pricing.mdx), footnote 2 |
| Durable Object duration | 13,000 GB-s / day, billed at 128 MB per object while it cannot hibernate | same, footnotes 4–5 |
| Worker requests | 100,000 / day; a WebSocket is one request for its whole life; its messages are free; static assets are free | [Workers pricing](https://github.com/cloudflare/cloudflare-docs/blob/0d6b59726ff1ac17417e9840e4aa5af799ea89b0/src/content/docs/workers/platform/pricing.mdx) |
| Worker CPU | 10 ms per request | [Workers limits](https://github.com/cloudflare/cloudflare-docs/blob/0d6b59726ff1ac17417e9840e4aa5af799ea89b0/src/content/docs/workers/platform/limits.mdx#L67-L75) |

## The measured message rate

The mock car sends what the real car's `dashboard_node` sends, at the same rates. Measured by the relay itself in `wrangler dev` (its `upstream_disconnect` log line):

**42.6 messages a second** from the car into the relay.

**Terminal 1** — run the mock and watch its own count:

```bash
npm run mock
```

**Working when:** every 5 s it prints a `[rates]` line such as `relay: 1 conn, 40.4 msg/s per conn (31.2 text + 9.2 binary), 41.0 kB/s per conn`.

| Stream | Messages / s | Why |
|---|---|---|
| `batch` (pose, command, speed, intent, stopwatch, stats) | 20 | `telemetry_rate_hz: 20` |
| `scan` header + binary | 20 | 10 scans a second, two frames each |
| `map_patch` header + binary | about 2 | one map update a second while mapping |
| keyframe every 30 s | under 0.1 | |
| **total** | **about 42** | the car repo measured ~40 frames/s on the real car |

The relay's viewers also send a heartbeat every 10 s (0.1 message a second each). It is answered without waking the relay, but is assumed to count as an incoming message: 18 requests an hour per viewer, which is noise next to the car.

## Viewing hours per day, per car, on the Free plan

One hour of a car connected to its relay costs:

| Resource | Per hour | Free per day | Hours per day |
|---|---|---|---|
| DO requests | 42.6 × 3,600 / 20 = **7,668** | 100,000 | **13.0** |
| DO duration | 0.125 GB × 3,600 s = **450 GB-s** | 13,000 GB-s | 28.9 |

So **about 13 hours a day**, shared by every car, and the number of viewers does not change it. Two cars watched at the same time use it twice as fast.

Add about one minute per viewing session for the idle grace period (`UPSTREAM_IDLE_SEC`).

<details>
<summary><b>Everything else that uses requests</b> — small, but listed so nothing is a surprise. Skip it unless you are near a limit.</summary>

| Action | Worker requests | DO requests |
|---|---|---|
| Opening the simple dashboard | about 9 (page, scripts, styles, sockets) | 1 |
| Opening Lichtblick | a few dozen (it loads its code in chunks) | 0 |
| Landing page open | 1 every 30 s while visible (120 an hour) | 1 per car per poll |
| Camera inset while the camera is **offline** | 1 every 3 s per open tab (1,200 an hour) — the page retries | 0 |
| Relay reconnecting to an offline car | 0 | 1 alarm per attempt, backing off to one per 30 s (about 120 an hour) |
| `/control` link | 1 per opening | 0 |

The camera retry is the one to watch: a tab left open with the camera node off makes 28,800 Worker requests a day. [follow-ups.md](follow-ups.md) has the fix.

</details>

**Assumption to confirm.** The pricing footnote counts "incoming WebSocket messages" without saying whether that includes messages a Durable Object *receives* on a connection it opened itself (the relay's link to the car).

This page assumes it does, which is the expensive reading. If it does not, the request limit stops mattering and the limit becomes duration: **28.9 hours a day**. After a first real session, the Cloudflare dashboard's Durable Objects metrics will show which.

## When Workers Paid is worth it

Workers Paid is $5 a month (Durable Objects pricing lists the $5 minimum). It includes, per month:

- 10 million Worker requests, then $0.30 per million
- 1 million Durable Object requests, then $0.15 per million
- 400,000 GB-s of Durable Object duration, then $12.50 per million GB-s

That is about **130 viewing hours a month** included (1,000,000 / 7,668), limited by requests again. Past it, an hour costs about 7,668 × $0.15/M + 450 × $12.50/M ≈ **$0.007**. A month of 4 hours a day is 120 hours: inside the $5.

It is worth it when any of these happens:

1. **A day needs more than about 13 hours** — a competition weekend with the dashboards open all day. On Free, the relay stops working at the limit until midnight UTC; on Paid the limit is monthly and soft.
2. **You want full bridge logs** (`BRIDGE_TRACKING=relay`, which needs more than 10 ms of CPU per connection). See [decisions.md](decisions.md#proxying-websockets-from-the-worker).
3. **Lichtblick grows past 20,000 files**, the Free per-version limit (it is 219 deployed files today).

## What a protocol v2 would save

A v2 that packs each header and its binary into one frame removes one message per scan and per map update. It does **not** roughly halve the count on today's mix, because most messages are batch frames that carry no binary:

| | Messages / s | DO requests / hour | Free hours / day |
|---|---|---|---|
| Today | 42.6 | 7,668 | 13.0 |
| v2 (one frame per scan and per map update) | about 31.5 | about 5,670 | about 17.6 |
| v2 and `telemetry_rate_hz: 10` | about 21.5 | about 3,870 | about 25.8 |

Halving the batch rate is the bigger lever. The browser redraws at most 60 times a second and a person reads far slower, so 10 Hz telemetry would still look live; it is a car-side setting, `telemetry_rate_hz` in `web_dashboard.yaml`.
