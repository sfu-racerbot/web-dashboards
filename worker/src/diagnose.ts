// /<car>/check: "why can't the site reach the car?", answered by the Worker
// itself, from where it sits, with the real service token.
//
// It tries each of the car's three origins the way the site does and
// explains each answer in plain words. It is behind the same Access login
// as everything else, never prints a secret's value, and never reads a
// response body beyond the first few hundred bytes (to spot Cloudflare's
// numbered error pages).

import { CAR_WS_PATH, serviceToken, tokenShape, type CarConfig, type Env } from "./config";

export interface HopResult {
  name: string;
  url: string;
  ok: boolean;
  status: number | null;
  meaning: string;
  fix?: string;
}

export const WAF_FIX =
  "In Security > WAF > Custom rules (or Security rules), edit the challenge rule so it does not apply to "
  + "the Worker's own requests: add `and cf.worker.upstream_zone != \"sfuracerbot.ca\"` to the end of its expression. "
  + "The car's -origin hostnames are already closed to everyone but the Worker by their Service Auth Access policy. "
  + "See docs/cloudflare-setup.md, \"If your zone has a WAF challenge rule\".";

/** Cloudflare's own error pages carry "error code: 1033" or "Error 1033". */
export function cloudflareErrorCode(body: string): number | null {
  const match = /error(?: code)?:?\s*(1\d{3})/i.exec(body);
  return match ? Number(match[1]) : null;
}

/** Turn one origin's answer into a sentence. Pure, so it is unit-tested. */
export function explain(
  hop: "dashboard" | "dashboard websocket" | "bridge" | "camera",
  status: number,
  location: string | null,
  errorCode: number | null,
  mitigated: string | null = null,
): { ok: boolean; meaning: string; fix?: string } {
  if (mitigated === "challenge") {
    return {
      ok: false,
      meaning: "A Cloudflare WAF / bot challenge answered instead of the car. The Worker cannot solve a challenge the way a browser can, so the zone's challenge rule is stopping the site at the car's hostname.",
      fix: WAF_FIX,
    };
  }
  if (errorCode === 1020) {
    return {
      ok: false,
      meaning: "A Cloudflare WAF rule blocked the Worker's request to the car (error 1020).",
      fix: WAF_FIX,
    };
  }
  const accessLogin = location !== null && /cloudflareaccess\.com/.test(location);
  if (accessLogin) {
    return {
      ok: false,
      meaning: "Cloudflare Access sent the Worker to a login page instead of letting its service token in.",
      fix: "Zero Trust > Access controls > Applications: open the application for the car's -origin hostnames (setup step 2). "
        + "(1) Its policy's Action must be Service Auth -- not Allow -- with an Include rule of Service Token = the token whose "
        + "values are in the Worker secrets. (2) No other Access application may cover these hostnames (for example a "
        + "*.sfuracerbot.ca one with your email list). (3) The token must not be expired. Tip: turn on \"401 Response for "
        + "Service Auth policies\" in that application's settings; then a wrong token shows here as 401, and a 302 means "
        + "the policy/application is the problem.",
    };
  }
  if (status === 401 || status === 403) {
    return {
      ok: false,
      meaning: `Cloudflare Access refused the Worker's service token (HTTP ${status}).`,
      fix: "Check the Worker secrets ACCESS_CLIENT_ID and ACCESS_CLIENT_SECRET match the token in the origin Access policy (setup steps 1, 2 and 6), are not swapped, and the token has not expired.",
    };
  }
  if (errorCode === 1016) {
    return {
      ok: false,
      meaning: "This hostname has no DNS record (error 1016).",
      fix: "Add the tunnel's published application route for this hostname (setup step 4 / car README step 4).",
    };
  }
  if (errorCode === 1033 || status === 530) {
    return {
      ok: false,
      meaning: `The car's tunnel is not connected to Cloudflare (HTTP ${status}${errorCode ? `, error ${errorCode}` : ""}).`,
      fix: "On the car: `sudo systemctl status cloudflared`. The tunnel should show Healthy under Networking > Tunnels. Is the car on and online?",
    };
  }
  if (status === 502 || status === 503 || status === 504) {
    return {
      ok: false,
      meaning: `The tunnel is up, but nothing answered on the car's port for this service (HTTP ${status}).`,
      fix: hop === "bridge"
        ? "On the car: is foxglove_bridge running on port 8765? `car/check.sh` says."
        : hop === "camera"
          ? "On the car: is the camera stream running on port 9090? `car/check.sh` says."
          : "On the car: is dashboard_node running on port 8080? `car/check.sh` says. Also check the tunnel route's service URL is http://localhost:8080.",
    };
  }
  if (hop === "dashboard websocket") {
    if (status === 101) return { ok: true, meaning: "The car's dashboard_node accepted a WebSocket, as the relay needs." };
    return {
      ok: false,
      meaning: `The car answered HTTP ${status} to a WebSocket request instead of accepting it.`,
      fix: status === 404
        ? "The tunnel route probably points at the wrong port or service. rb2-dash-origin must be http://localhost:8080."
        : "Check the tunnel route for rb2-dash-origin is http://localhost:8080 and that dashboard_node is the program on that port.",
    };
  }
  if (hop === "bridge") {
    // A plain GET to a WebSocket-only server gets a 4xx; any answer from the
    // bridge itself means the path works.
    if (status >= 200 && status < 500) return { ok: true, meaning: `foxglove_bridge answered (HTTP ${status}, expected for a plain request).` };
  }
  if (status >= 200 && status < 400) return { ok: true, meaning: `Reached (HTTP ${status}).` };
  if (status === 404 && hop === "camera") return { ok: true, meaning: "The camera node answered (HTTP 404 for its front page is fine)." };
  return { ok: false, meaning: `Unexpected answer: HTTP ${status}.` };
}

async function probe(
  hop: "dashboard" | "dashboard websocket" | "bridge" | "camera",
  url: string,
  headers: Record<string, string>,
): Promise<HopResult> {
  let response: Response;
  try {
    response = await fetch(url, { headers, redirect: "manual" });
  } catch (err) {
    return {
      name: hop, url, ok: false, status: null,
      meaning: `The Worker could not reach this hostname at all: ${(err as Error).message}`,
      fix: "Check the hostname exists: the tunnel's published application route creates its DNS record (setup step 4).",
    };
  }
  let body = "";
  if (response.status !== 101 && response.body) {
    const reader = response.body.getReader();
    const chunk = await reader.read().catch(() => ({ value: undefined }));
    reader.cancel().catch(() => {});
    if (chunk.value) body = new TextDecoder().decode(chunk.value.slice(0, 600));
  }
  if (response.webSocket) {
    response.webSocket.accept();
    response.webSocket.close(1000, "check done");
  }
  const verdict = explain(hop, response.status, response.headers.get("Location"), cloudflareErrorCode(body),
    response.headers.get("cf-mitigated"));
  return { name: hop, url, status: response.status, ...verdict };
}

export async function diagnose(env: Env, carId: string, car: CarConfig): Promise<Response> {
  const token = serviceToken(env);
  const results: HopResult[] = [];
  // Names only -- never values -- of everything the running Worker was given,
  // so a secret stored somewhere the Worker does not read (Build variables,
  // Preview settings, another Worker) or under a slightly different name
  // shows up as what it is.
  const names = Object.keys(env as unknown as Record<string, unknown>).sort();
  const nearMisses = names.filter((n) => /access|client|secret/i.test(n)
    && n !== "ACCESS_CLIENT_ID" && n !== "ACCESS_CLIENT_SECRET");
  if (!token.ok) {
    const missing = ["ACCESS_CLIENT_ID", "ACCESS_CLIENT_SECRET"].filter((name) => !(env as unknown as Record<string, unknown>)[name]);
    results.push({
      name: "worker secrets", url: "", ok: false, status: null,
      meaning: `The running Worker has no ${missing.join(" and no ")}, so the site cannot identify itself to the car.`,
      fix: "Workers & Pages > web-dashboards > Settings > Runtime variables and secrets (Production selected) > "
        + "Add variable, with Type: Secret and the names exactly ACCESS_CLIENT_ID and ACCESS_CLIENT_SECRET. "
        + "Not in the Variables and secrets box inside the Builds section (build-time only), and not under Previews Base. "
        + "Deploy, then reload this page."
        + (nearMisses.length ? ` The Worker DOES have ${nearMisses.join(", ")}: rename to the exact names above.` : ""),
    });
  } else {
    const shape = tokenShape(token.id, token.secret);
    results.push(shape.length
      ? {
        name: "worker secrets", url: "", ok: false, status: null,
        meaning: shape.join(" "),
        fix: "Copy the Client ID and Client Secret again from Zero Trust > Access controls > Service credentials > Service Tokens "
          + "(a lost secret needs Rotate), and set them in Settings > Runtime variables and secrets.",
      }
      : { name: "worker secrets", url: "", ok: true, status: null, meaning: "ACCESS_CLIENT_ID and ACCESS_CLIENT_SECRET are both set, and look like a Client ID and a Client Secret." });
    const auth = { "CF-Access-Client-Id": token.id, "CF-Access-Client-Secret": token.secret };
    results.push(...await Promise.all([
      probe("dashboard websocket", `${car.dash_origin}${CAR_WS_PATH}?role=relay`, {
        ...auth, Upgrade: "websocket", "X-Racerbot-Role": "relay", Origin: env.PUBLIC_ORIGIN,
      }),
      probe("bridge", `${car.bridge_origin}/`, auth),
      probe("camera", `${car.cam_origin}/`, auth),
    ]));
  }
  let relay: unknown;
  try {
    relay = await env.CAR_RELAY.getByName(carId).status();
  } catch (err) {
    relay = { error: (err as Error).message };
  }
  const allOk = results.every((r) => r.ok);
  return new Response(JSON.stringify({
    car: carId,
    summary: allOk
      ? "Every hop from the site to the car works. If the dashboard still shows the car offline, reload it."
      : `Not working: ${results.filter((r) => !r.ok).map((r) => r.name).join(", ")}. See each "fix".`,
    checks: results,
    worker_setting_names: names,
    relay,
    checked_at: new Date().toISOString(),
  }, null, 2), { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}
