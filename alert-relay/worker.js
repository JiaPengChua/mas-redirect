/*
  Booking redirect alert relay (Cloudflare Worker).

  The booking handler on the website sends a beacon here when a redirect fails.
  This Worker checks it came from an allowed site, rate-limits, and posts the
  alert to Slack. The Slack webhook URL stays here as a secret, never in page code.

  Settings (Cloudflare dashboard or `wrangler secret put` / wrangler.toml [vars]):
    SLACK_WEBHOOK_URL  (secret)  Slack incoming-webhook or Workflow Builder webhook URL
    ALLOWED_ORIGINS    (var)     comma-separated sites allowed to send alerts
    ADA_DASHBOARD_URL  (var)     e.g. https://malaysiaairlines-sandbox.ada.support
*/
const EVENTS = ["flight_booking", "express_booking", "flight_reaccommodation"];
const MAX_BODY = 4000;
const PER_MINUTE = 20;           // per site, per Worker instance (best effort)
const recent = new Map();        // site -> timestamps (ms) in the last minute
const seenIds = new Map();       // alert_id -> time, to drop duplicates

const clip = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u001f]/g, " ").slice(0, n);

function cors(origin) {
  return { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "content-type", "Vary": "Origin" };
}

function rateLimited(site, now) {
  const times = (recent.get(site) || []).filter((t) => now - t < 60000);
  times.push(now);
  recent.set(site, times);
  return times.length > PER_MINUTE;
}

function slackMessage(a, dashboard) {
  const lines = [
    ":rotating_light: *Booking redirect failed*",
    `*Event:* ${a.event}`,
    `*Reason:* ${a.reason || "unknown"}`,
    `*Page:* ${a.page || "unknown"}`,
    `*When:* ${a.at || new Date().toISOString()}`,
    `*Alert ID:* \`${a.alert_id}\` — also saved on the Ada conversation as \`booking_redirect_id\``,
  ];
  if (dashboard) lines.push(`<${dashboard}/insights/conversations|Open Ada conversations>`);
  const text = lines.join("\n");
  return text;
}

// Workflow Builder webhooks (hooks.slack.com/triggers/...) expect exactly the variables defined in the
// workflow — set it up with a single `text` variable. Incoming webhooks (/services/...) take { text }.
function slackBody(webhookUrl, text) {
  return JSON.stringify({ text });
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    const allowed = String(env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: allowed.includes(origin) ? cors(origin) : {} });
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    if (!allowed.includes(origin)) return new Response("Forbidden", { status: 403 });
    if (!env.SLACK_WEBHOOK_URL) return new Response("Not configured", { status: 500 });

    const body = await request.text();
    if (body.length > MAX_BODY) return new Response("Too large", { status: 413 });
    let input;
    try { input = JSON.parse(body); } catch { return new Response("Bad JSON", { status: 400 }); }

    const alert = {
      event: EVENTS.includes(input.event) ? input.event : "unknown",
      reason: clip(input.reason, 200),
      page: clip(input.page, 300),
      at: clip(input.at, 40),
      alert_id: clip(input.alert_id, 40) || crypto.randomUUID().slice(0, 8),
    };
    const now = Date.now();
    if (seenIds.has(alert.alert_id)) return new Response(null, { status: 204, headers: cors(origin) });
    seenIds.set(alert.alert_id, now);
    for (const [k, t] of seenIds) if (now - t > 3600000) seenIds.delete(k);
    if (rateLimited(origin, now)) return new Response("Rate limited", { status: 429, headers: cors(origin) });

    ctx.waitUntil(fetch(env.SLACK_WEBHOOK_URL, {
      method: "POST", headers: { "content-type": "application/json" },
      body: slackBody(env.SLACK_WEBHOOK_URL, slackMessage(alert, env.ADA_DASHBOARD_URL)),
    }).catch(() => {}));
    return new Response(null, { status: 204, headers: cors(origin) });
  },
};
