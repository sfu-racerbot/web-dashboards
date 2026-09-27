# Setting up Cloudflare for the dashboards

> **Who this is for:** the team member with access to the `sfuracerbot.ca` Cloudflare account, setting this up for the first time or adding a car.
> **Read first:** [../README.md](../README.md) (the diagram), and [security.md](security.md) for why each lock exists.
> **You'll be able to:** put the dashboards live at https://dashboard.sfuracerbot.ca, open to a list of team emails and nobody else, and add a car with a config change.
> **Time:** about an hour the first time; ten minutes per extra car.

Most of this is clicking in the Cloudflare dashboard, because it sets up who is allowed in, and that should not live in a repo. Steps marked **👤 Dashboard** can only be done by a person there. A few checks are commands in a terminal.

**Do the steps in order.** The Access applications come before anything is reachable, so nothing is ever briefly open to the internet.

## Before you start

- [ ] `sfuracerbot.ca` is an active zone in the Cloudflare account, with Cloudflare managing its DNS (a "full setup").
- [ ] Zero Trust is enabled on the account (**Zero Trust** in the dashboard's left bar opens without asking you to sign up), with a login method — the built-in **One-time PIN** (a code by email) is enough.
- [ ] The car has its tunnel and three servers set up, following [car/README.md](../car/README.md). (Its step 4 sends you back here for the Access and route steps.)

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

## 5. Connect this repo to Cloudflare, so every merge deploys — 👤 Dashboard

Cloudflare builds and deploys the site itself, straight from GitHub (this is called **Workers Builds**). Nothing is deployed from GitHub Actions, and **GitHub needs no secrets**.

1. Go to **Workers & Pages**, select **Create application**, then **Get started** next to **Import a repository**.
2. Connect GitHub if asked, and choose `sfu-racerbot/web-dashboards`.
3. Configure the project:

   | Setting | Value | Why |
   |---|---|---|
   | Project (Worker) name | `racerbot-dashboard` | Must match `name` in `wrangler.jsonc`, or the build fails |
   | Build command | `npm run build` | Builds Lichtblick from source and assembles `dist/` (about 5 minutes) |
   | Deploy command | `npx wrangler deploy` | The default |
   | Root directory | `/` | The default |
   | Production branch | `main` | |

4. Select **Save and Deploy**.
5. In the new Worker, go to **Settings** > **Build** > **Branch control** and **untick Enable Preview Builds**. The site has no preview URLs (they would skip Access), so preview builds could only fail.

**Working when:** the build log ends with the deploy listing `dashboard.sfuracerbot.ca (custom domain)`. The landing page opens, but the dashboards cannot reach the car yet, and their sockets answer `secret ACCESS_CLIENT_ID is not set` — expected until step 6.

**If it doesn't:**
- "The name in your Wrangler configuration file … must match": the project name in step 3 was different. Rename the Worker, or change `name` in `wrangler.jsonc` to match.
- The deploy fails on the custom domain (permissions, or "a DNS record already exists"): delete any old `dashboard` record in **DNS** > **Records**, or add the domain by hand in the Worker's **Settings** > **Domains & Routes** > **Add** > **Custom domain**, then **Retry build**.
- The build runs out of time or memory: Cloudflare's free build machine has 2 CPUs, 8 GB and 20 minutes; the build needs about a third of that. Retry once; if it recurs, see `apps/advanced/README.md`.

Every push to `main` from then on deploys by itself. The GitHub Actions workflow still runs the tests and a Lichtblick build on every pull request, as a check, with no secrets.

## 6. Give the Worker the service token — 👤 Dashboard

These are the Worker's **runtime** secrets. They are set once, in Cloudflare, and survive every later deploy. They are never in the repo or in GitHub.

1. In **Workers & Pages**, open `racerbot-dashboard`, go to **Settings** > **Variables and Secrets**, and select **Add**.
2. **Type:** Secret. **Variable name:** `ACCESS_CLIENT_ID`. **Value:** the Client ID from step 1. Deploy.
3. Again for `ACCESS_CLIENT_SECRET`, with the Client Secret.

Put them under **Variables and Secrets**, not under **Settings** > **Build** > **Build variables and secrets** — those exist only while building and the running site never sees them.

**Working when:** both names are listed as secrets (their values are hidden).

(The same thing from a terminal, if you prefer: `npx wrangler secret put ACCESS_CLIENT_ID`, then `ACCESS_CLIENT_SECRET`.)

## 7. Check it end to end

With the car on and its tunnel, `dashboard_node`, `foxglove_bridge` and camera running:

1. Open https://dashboard.sfuracerbot.ca in a private window. **Working when:** Access asks for your email, then the landing page lists **Car 2**.
2. Open **Simple**. **Working when:** the link row under `CONNECTED` reads `CAR ONLINE · 1 WATCHING`, the map and scan draw, and the camera inset shows video.
3. Open **Advanced** in Chrome or Edge. **Working when:** Lichtblick opens already connected to `wss://dashboard.sfuracerbot.ca/rb2/bridge` and the topic list fills in.
4. In the Cloudflare dashboard, **Workers & Pages** > `racerbot-dashboard` > **Observability** (logs). **Working when:** you see `upstream_connect` for `rb2` and a `bridge_connect` with your email.

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
