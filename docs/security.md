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

## 4. OnePortal decides who may view and who may drive

Per-person, per-car permissions live in OnePortal (`https://oneportal.sighton.ca`), not here. Each person has, per car, **view** or **control** (or nothing). The code is [`worker/src/gate.ts`](../worker/src/gate.ts) and [`worker/src/oneportal.ts`](../worker/src/oneportal.ts).

1. The **Dashboard** button in OnePortal asks OnePortal for a *pass*. OnePortal signs it with its own Ed25519 key. The pass names the email, the car and the role, and lasts 2 minutes.
2. The browser opens `/<car>/simple/?oneportal_pass=…`. The Worker checks four things:
   - the signature, with OnePortal's **public** key (`ONEPORTAL_PASS_PUBLIC_KEY` in `wrangler.jsonc`)
   - the expiry
   - that the pass is for this car
   - that the email is the one Access signed in

   It then sets its own cookie, `op_<car>`: HttpOnly, path `/<car>/`, 15 minutes, HMAC-signed with the Worker secret `ONEPORTAL_COOKIE_SECRET`. Last, it redirects to the same URL without the pass.
3. Every car route needs that cookie: pages, `/ws`, `/control`, `/bridge`, `/camera`, `/check`.
   - Without it, a page load is sent to OnePortal's `/dashboard/refresh`. OnePortal issues a fresh pass with the person's **current** role, or refuses.
   - Anything else gets `401`.
   - So a permission change in OnePortal applies within 15 minutes.
4. **`/control` and `/bridge` need the control role.** The bridge counts as a write path because Lichtblick can set parameters and call services through it. A viewer gets `403 You can view this car but not change it`. The simple page asks `/<car>/access` for its role and hides the write controls for viewers. Hiding them is only for clarity; the Worker's refusal is the real lock.
5. **`REQUIRE_ONEPORTAL`** is a Worker variable set on the Worker, not in `wrangler.jsonc`:
   - `"1"` makes OnePortal the only way in. `/` redirects to OnePortal, and `/api/cars` answers `403`.
   - Unset, Access alone still gives full access, as before. This exists for the staged rollout only.
   - Required but the key or secret missing: everything answers `500`. It fails closed.

The browser's `Cookie` header is stripped before anything reaches the car (section 3), so the `op_<car>` cookie never leaves the Worker.

**Known limits.**
- A control connection that is already open is not cut when its cookie runs out. The Worker hands the socket to the car (no Worker code in the data path, see `docs/decisions.md`), so it cannot close it later. The page closes the control link after 5 minutes without a write, and every reopen is checked again.
- A pass can be used more than once within its 2 minutes, but only by the same signed-in person.

## What would break this

| If this happens | Then |
|---|---|
| The Worker is reachable without Access (a `workers.dev` or preview URL, a second route) | Anyone could send `Cf-Access-Authenticated-User-Email` and be any user. **`workers_dev` and `preview_urls` are off in `wrangler.jsonc`; keep them off.** |
| An origin's Access app is removed or its policy loosened | Anyone who finds the hostname could talk to the car and claim any user. |
| The service token leaks | Rotate it on its page in the dashboard ([cloudflare-setup.md](cloudflare-setup.md), step 1), then set both Worker secrets again (step 6). |
| The Worker stops stripping browser headers | Anyone on the email list could act as anyone else, or open a control connection as the relay. |
| OnePortal's signing key leaks (`~/.config/oneportal/dashboard-pass-key.pem` on the OnePortal server) | Anyone on the Access list could mint a control pass. Delete the key file, restart OnePortal (it makes a new one and logs the new public key), and update `ONEPORTAL_PASS_PUBLIC_KEY`. |
| `ONEPORTAL_COOKIE_SECRET` leaks | Anyone on the Access list could forge a control cookie. Set a new random value; every open session is sent back through OnePortal. |
| `REQUIRE_ONEPORTAL` is removed | Access alone gives full control again, as before OnePortal. |

## Deliberately not protected

- **Before `REQUIRE_ONEPORTAL=1`, anyone on the email list can do anything the dashboard can.** After it, OnePortal's view/control role decides (section 4). Tuning still needs arming, per connection, and the car still enforces every bound it always did.
- **The relay is read-only and shared.** Everyone watching sees the same telemetry.

## Improvements worth making

Listed in [follow-ups.md](follow-ups.md): validating the Access JWT in the Worker (so a mis-configured route cannot make the email header forgeable), and per-user permissions for the write actions.
