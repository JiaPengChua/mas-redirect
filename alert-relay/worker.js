/*
  Booking redirect alert relay (Cloudflare Worker).

  The booking handler on the website sends a beacon here when a redirect fails.
  This Worker checks it came from an allowed site, rate-limits, and posts the
  alert to Slack and/or Microsoft Teams. The webhook URLs stay here as secrets,
  never in page code. Set at least one of them.

  Settings (Cloudflare dashboard or `wrangler secret put` / wrangler.toml [vars]):
    SLACK_WEBHOOK_URL  (secret)  Slack incoming-webhook or Workflow Builder webhook URL
    TEAMS_WEBHOOK_URL  (secret)  Teams Workflows URL ("Post to a channel when a webhook request is received")
    ALLOWED_ORIGINS    (var)     comma-separated sites allowed to send alerts
    ADA_DASHBOARD_URL  (var)     e.g. https://malaysiaairlines-sandbox.ada.support
*/
const EVENTS = ["flight_booking", "express_booking", "flight_reaccommodation"];
const MAX_BODY = 4000;
const PER_MINUTE = 20;           // per site, per Worker instance (best effort)
const recent = new Map();        // site -> timestamps (ms) in the last minute
const seenIds = new Map();       // alert_id -> time, to drop duplicates

// "19 Oct 2026, 12:13:19 pm (SGT)" — alerts are read in Singapore, so show Singapore time, labelled.
function sgt(iso) {
  const d = new Date(iso);
  const when = isNaN(d) ? new Date() : d;
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Singapore", day: "numeric", month: "short", year: "numeric",
    hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true,
  }).formatToParts(when).map((x) => [x.type, x.value]));
  return `${p.day} ${p.month} ${p.year}, ${p.hour}:${p.minute}:${p.second} ${String(p.dayPeriod).toLowerCase()} (SGT)`;
}

const FIND_HINT = (id) => `Find the Ada conversation whose booking_redirect_id is ${id} — it may not be the newest one. ` +
  "Test alerts sent without a chat have no conversation.";

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
    `*When:* ${sgt(a.at)}`,
    `*Alert ID:* \`${a.alert_id}\``,
    `_${FIND_HINT(a.alert_id)}_`,
  ];
  if (dashboard) lines.push(`<${dashboard}/insights/conversations|Ada conversation list>`);
  const text = lines.join("\n");
  return text;
}

// Workflow Builder webhooks (hooks.slack.com/triggers/...) expect exactly the variables defined in the
// workflow — set it up with a single `text` variable. Incoming webhooks (/services/...) take { text }.
function slackBody(webhookUrl, text) {
  return JSON.stringify({ text });
}

// Teams Workflows ("Post to a channel when a webhook request is received") expects a message whose
// attachments carry an Adaptive Card.
function teamsBody(a, dashboard) {
  const card = {
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    type: "AdaptiveCard",
    version: "1.4",
    body: [
      { type: "TextBlock", text: "\u{1F6A8} Booking redirect failed", weight: "Bolder", size: "Medium", color: "Attention", wrap: true },
      { type: "FactSet", facts: [
        { title: "Event", value: a.event },
        { title: "Reason", value: a.reason || "unknown" },
        { title: "Page", value: a.page || "unknown" },
        { title: "When", value: sgt(a.at) },
        { title: "Alert ID", value: a.alert_id },
      ] },
      { type: "TextBlock", text: FIND_HINT(a.alert_id), isSubtle: true, size: "Small", wrap: true },
    ],
    actions: dashboard ? [{ type: "Action.OpenUrl", title: "Ada conversation list", url: `${dashboard}/insights/conversations` }] : [],
  };
  return JSON.stringify({ type: "message", attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", contentUrl: null, content: card }] });
}

// Logs only the destination name and HTTP status (visible with `wrangler tail`), never the URL.
function post(name, url, body) {
  return fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body }).then(
    (r) => { console.log(`[relay] ${name} -> HTTP ${r.status}`); return r; },
    (e) => { console.log(`[relay] ${name} -> error ${e && e.message}`); throw e; });
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    const allowed = String(env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: allowed.includes(origin) ? cors(origin) : {} });
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    if (!allowed.includes(origin)) return new Response("Forbidden", { status: 403 });
    if (!env.SLACK_WEBHOOK_URL && !env.TEAMS_WEBHOOK_URL) return new Response("Not configured", { status: 500 });

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

    // Each destination is independent: one failing never stops the other.
    const sends = [];
    if (env.SLACK_WEBHOOK_URL) sends.push(post("slack", env.SLACK_WEBHOOK_URL, slackBody(env.SLACK_WEBHOOK_URL, slackMessage(alert, env.ADA_DASHBOARD_URL))));
    if (env.TEAMS_WEBHOOK_URL) sends.push(post("teams", env.TEAMS_WEBHOOK_URL, teamsBody(alert, env.ADA_DASHBOARD_URL)));
    ctx.waitUntil(Promise.allSettled(sends));
    return new Response(null, { status: 204, headers: cors(origin) });
  },
};
