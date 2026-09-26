# Security: who can reach the car, and why the car can trust what it is told

> **Who this is for:** anyone changing Access settings, the Worker's headers, or the car's handling of `X-Racerbot-User`.
> **Read first:** [../README.md](../README.md) for the request path.
> **What's in it:** the three locks, what each one protects, and the one assumption everything rests on.

The dashboards can change how a car drives (live tuning), stop its processes, and delete saved maps. So "who can do that" has a precise answer, in three layers.

## 1. Cloudflare Access decides who can open anything

`dashboard.sfuracerbot.ca` sits behind a Cloudflare Access application that admits **a short list of specific team emails** and nobody else. Every page, every WebSocket and every camera frame goes through it. Someone not on the list gets the Access login page and never reaches the Worker.

## 2. The car origins accept only this Worker

The three tunnel hostnames (`rb2-dash-origin`, `rb2-bridge-origin`, `rb2-cam-origin`) each have their own Access application with a **Service Auth** policy that allows **one service token and nothing else**. The token's secret is a Worker secret (`ACCESS_CLIENT_SECRET`); it is never in the repo, CI, a log, or an error message.

So the only thing on the internet that can open a connection to the car is this Worker. A team member cannot reach the origins directly either — that is on purpose.

## 3. The car trusts `X-Racerbot-User` and `X-Racerbot-Role` only because of 1 and 2

The Worker tells the car who is acting (`X-Racerbot-User`, the Access-verified email) and in what role (`X-Racerbot-Role`: `relay` or `control`). The car can log and act on those headers **only because nothing but this Worker can reach it (2), and the Worker only lets in people Access admitted (1).**

**That trust would be worthless if a browser could set the headers itself.** So before adding its own, the Worker deletes every header starting `X-Racerbot-`, plus any `CF-Access-Client-*` token, `Cookie`, `Authorization` and `Cf-Access-*` header the browser sent. The unit tests in [`worker/test/headers.test.ts`](../worker/test/headers.test.ts) check exactly that, including mixed-case spellings.

The user's own Access session cookie is not forwarded to the car, for the same reason: the car has no use for it and it is a credential.

## What would break this

| If this happens | Then |
|---|---|
| The Worker is reachable without Access (a `workers.dev` or preview URL, a second route) | Anyone could send `Cf-Access-Authenticated-User-Email` and be any user. **`workers_dev` and `preview_urls` are off in `wrangler.jsonc`; keep them off.** |
| An origin's Access app is removed or its policy loosened | Anyone who finds the hostname could talk to the car and claim any user. |
| The service token leaks | Rotate it (docs/cloudflare-setup.md, step 3), then `wrangler secret put` both halves again. |
| The Worker stops stripping browser headers | Anyone on the email list could act as anyone else, or open a control connection as the relay. |

## Deliberately not protected

- **Anyone on the email list can do anything the dashboard can.** Access says who you are, not what you may do; there are no per-user permissions. Tuning still needs arming, per connection, and the car still enforces every bound it always did.
- **The relay is read-only and shared.** Everyone watching sees the same telemetry.

## Improvements worth making

Listed in [follow-ups.md](follow-ups.md): validating the Access JWT in the Worker (so a mis-configured route cannot make the email header forgeable), and per-user permissions for the write actions.
