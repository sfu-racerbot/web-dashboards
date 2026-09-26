# Setting up Cloudflare for the dashboards

> **Who this is for:** the team member with access to the `sfuracerbot.ca` Cloudflare account, setting this up for the first time or adding a car.
> **Read first:** [../README.md](../README.md) (the diagram), and [security.md](security.md) for why each lock exists.
> **You'll be able to:** put the dashboards live at https://dashboard.sfuracerbot.ca, open to a list of team emails and nobody else, and add a car with a config change.
> **Time:** about an hour the first time; ten minutes per extra car.

Most of this is clicking in the Cloudflare dashboard, because it sets up who is allowed in, and that should not live in a repo. Steps marked **👤 Dashboard** can only be done by a person there. Steps marked **⌨ Terminal** are commands.

**Do the steps in order.** The Access applications come before anything is reachable, so nothing is ever briefly open to the internet.

## Before you start

- [ ] `sfuracerbot.ca` is an active zone in the Cloudflare account, with Cloudflare managing its DNS (a "full setup").
- [ ] Zero Trust is enabled on the account (**Zero Trust** in the dashboard's left bar opens without asking you to sign up), with a login method — the built-in **One-time PIN** (a code by email) is enough.
- [ ] The car runs `cloudflared` as a remote-managed tunnel — the car session's docs cover installing it. You need to know its tunnel's name in **Networking** > **Tunnels**.
- [ ] You can run `npx wrangler login` on your laptop, or have a Cloudflare API token (step 7).

**Hostnames stay one level deep** (`rb2-dash-origin.sfuracerbot.ca`, not `dash.rb2.sfuracerbot.ca`). Cloudflare's free Universal SSL certificate covers `sfuracerbot.ca` and `*.sfuracerbot.ca` only, so a deeper name would have no certificate.

## 1. Create the Worker's service token — 👤 Dashboard

This is the Worker's key to the car. Only it will hold one.

1. Go to **Zero Trust** > **Access controls** > **Service credentials** > **Service Tokens**, and select **Create Service Token**.
2. Name it `racerbot-dashboard-worker`. Pick a duration (a year, with a calendar reminder to renew, is a reasonable default).
3. **Copy the Client ID and the Client Secret now.** The secret is shown once. New secrets start `cfast_`. Keep both somewhere private until step 6; do not paste them into chat, a commit or an issue.

**Working when:** the token is listed with its expiry date.

## 2. Lock the car's three origin hostnames to that token — 👤 Dashboard

Do this **before** step 4 creates the hostnames, so they are never open.

1. Go to **Zero Trust** > **Access controls** > **Applications**, **Create new application**, **Self-hosted and private**.
2. Name it `rb2 origins`. Select **Add public hostname** three times and enter:
   - `rb2-dash-origin` . `sfuracerbot.ca`
   - `rb2-bridge-origin` . `sfuracerbot.ca`
   - `rb2-cam-origin` . `sfuracerbot.ca`
3. Under **Access policies**, create a policy named `worker only` with **Action: Service Auth**, and one **Include** rule: **Service Token** is `racerbot-dashboard-worker`. Add no other policy.
4. Under **Additional settings**, turn on **401 Response for Service Auth policies**, so a missing token gets a plain 401 rather than a login page.
5. Select **Create**.

**Working when:** the application lists all three hostnames and exactly one policy, with action Service Auth.

**Why the action matters:** with any action other than Service Auth, Access answers the Worker's requests with a login page, and the car is never reached.

## 3. Put the site behind the team's email list — 👤 Dashboard

1. **Zero Trust** > **Access controls** > **Applications** > **Create new application** > **Self-hosted and private**.
2. Name it `Racerbot dashboards`. **Add public hostname**: `dashboard` . `sfuracerbot.ca`, with no path (it covers the whole site, including the WebSockets and `/api/cars`).
3. Under **Access policies**, create a policy `team` with **Action: Allow** and one **Include** rule: **Emails**, listing each team member's address. Specific addresses, not a domain.
4. **Session Duration:** `24 hours`. Long enough to cover a test day without logging in again; short enough that a lost laptop's session expires.
5. Under **Additional settings** > **Cookie settings**, make sure **Binding Cookie** is **off**.
6. Select **Create**.

**Working when:** the application shows `dashboard.sfuracerbot.ca` and the `team` policy.

**Adding or removing a person** later is editing that email list. Nothing in the repo changes.

## 4. Publish the car's three services through its tunnel — 👤 Dashboard

1. Go to **Networking** > **Tunnels**, select the car's tunnel, open the **Routes** tab.
2. **Add route** > **Published application**, three times:

   | Subdomain | Domain | Service |
   |---|---|---|
   | `rb2-dash-origin` | `sfuracerbot.ca` | `http://localhost:8080` (dashboard_node) |
   | `rb2-bridge-origin` | `sfuracerbot.ca` | `http://localhost:8765` (foxglove_bridge) |
   | `rb2-cam-origin` | `sfuracerbot.ca` | `http://localhost:9090` (usb_cam_stream) |

Cloudflare creates the DNS records itself.

**Working when** (**⌨ Terminal**, any machine):

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://rb2-dash-origin.sfuracerbot.ca/
```

prints `401`. That is Access refusing a request with no token — correct. A `200` means step 2 is missing a hostname: fix that first.

## 5. Deploy the Worker — ⌨ Terminal

**Terminal 1**, from the repo root, the first time only (after this, every merge to `main` deploys by itself, step 7):

```bash
npm ci
apps/advanced/build.sh
node scripts/assemble.mjs --require-advanced
npx wrangler login
npx wrangler deploy
```

**Working when:** the last command ends by listing `dashboard.sfuracerbot.ca (custom domain)`. Wrangler creates the DNS record and certificate for the custom domain.

**If it doesn't:** "a DNS record already exists" means something else already uses `dashboard.sfuracerbot.ca`; delete that record in **DNS** > **Records** and deploy again.

## 6. Give the Worker the service token — ⌨ Terminal

**Terminal 1**, from the repo root:

```bash
npx wrangler secret put ACCESS_CLIENT_ID
npx wrangler secret put ACCESS_CLIENT_SECRET
```

Each asks for the value; paste the ID, then the secret, from step 1. Secrets are stored encrypted by Cloudflare and survive every later deploy. They are never in the repo or in CI.

**Working when:** `npx wrangler secret list` shows both names (never their values).

## 7. Let GitHub deploy on every merge — 👤 Dashboard, then GitHub

1. In the Cloudflare dashboard, **My Profile** > **API Tokens** > **Create Token**, template **Edit Cloudflare Workers**. Limit it to this account and the `sfuracerbot.ca` zone.
2. Copy the account ID from **Workers & Pages** (right-hand column).
3. In GitHub, **sfu-racerbot/web-dashboards** > **Settings** > **Secrets and variables** > **Actions**, add repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

**Working when:** the next push to `main` runs the `ci` workflow's `deploy` job green. (It uses a GitHub environment called `production`, created on first use; add required reviewers to it there if deploys should need an approval.)

## 8. Check it end to end

With the car on and its tunnel, `dashboard_node`, `foxglove_bridge` and camera running:

1. Open https://dashboard.sfuracerbot.ca in a private window. **Working when:** Access asks for your email, then the landing page lists **Car 2**.
2. Open **Simple**. **Working when:** the link row under `CONNECTED` reads `CAR ONLINE · 1 WATCHING`, the map and scan draw, and the camera inset shows video.
3. Open **Advanced** in Chrome or Edge. **Working when:** Lichtblick opens already connected to `wss://dashboard.sfuracerbot.ca/rb2/bridge` and the topic list fills in.
4. In the Cloudflare dashboard, **Workers & Pages** > `racerbot-dashboard` > **Logs**. **Working when:** you see `upstream_connect` for `rb2` and a `bridge_connect` with your email.

**If Simple says `CAR OFFLINE`:** the relay could not reach the car. The row's tooltip, and the `upstream_failed` log line, say why: a secret not set (step 6), an origin answering 401/403 (step 2 or 4), or the car's dashboard_node not running.

## Adding a car

For a car `rb3`:

1. **👤 Dashboard** — step 2 again with `rb3-dash-origin`, `rb3-bridge-origin`, `rb3-cam-origin` (a new `rb3 origins` application, same `worker only` policy).
2. **👤 Dashboard** — step 4 again on **that car's** tunnel, with the `rb3-…` names.
3. **In the repo** — add one entry to `CARS` in [`wrangler.jsonc`](../wrangler.jsonc) and open a pull request:

   ```jsonc
   "rb3": {
     "name": "Car 3",
     "dash_origin": "https://rb3-dash-origin.sfuracerbot.ca",
     "bridge_origin": "https://rb3-bridge-origin.sfuracerbot.ca",
     "cam_origin": "https://rb3-cam-origin.sfuracerbot.ca"
   }
   ```

Merging deploys it. **Working when:** the landing page lists the new car. The same service token and the same email list cover it; no code changes.

## Removing access

| To remove | Do |
|---|---|
| A person | Remove their email from the `team` policy (step 3). |
| The Worker's access to the cars | Revoke the service token (step 1's page). Every car origin then refuses the Worker. |
| A car | Delete its `CARS` entry and merge; then delete its tunnel routes and origin application. |
