var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker.js
var EVENTS = ["flight_booking", "express_booking", "flight_reaccommodation"];
var MAX_BODY = 4e3;
var PER_MINUTE = 20;
var recent = /* @__PURE__ */ new Map();
var seenIds = /* @__PURE__ */ new Map();
var clip = /* @__PURE__ */ __name((v, n) => String(v == null ? "" : v).replace(/[\u0000-\u001f]/g, " ").slice(0, n), "clip");
function cors(origin) {
  return { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "content-type", "Vary": "Origin" };
}
__name(cors, "cors");
function rateLimited(site, now) {
  const times = (recent.get(site) || []).filter((t) => now - t < 6e4);
  times.push(now);
  recent.set(site, times);
  return times.length > PER_MINUTE;
}
__name(rateLimited, "rateLimited");
function slackMessage(a, dashboard) {
  const lines = [
    ":rotating_light: *Booking redirect failed*",
    `*Event:* ${a.event}`,
    `*Reason:* ${a.reason || "unknown"}`,
    `*Page:* ${a.page || "unknown"}`,
    `*When:* ${a.at || (/* @__PURE__ */ new Date()).toISOString()}`,
    `*Alert ID:* \`${a.alert_id}\` \u2014 also saved on the Ada conversation as \`booking_redirect_id\``
  ];
  if (dashboard) lines.push(`<${dashboard}/insights/conversations|Open Ada conversations>`);
  const text = lines.join("\n");
  return text;
}
__name(slackMessage, "slackMessage");
function slackBody(webhookUrl, text) {
  return JSON.stringify({ text });
}
__name(slackBody, "slackBody");
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
        { title: "When", value: a.at || (/* @__PURE__ */ new Date()).toISOString() },
        { title: "Alert ID", value: a.alert_id }
      ] },
      { type: "TextBlock", text: "The alert ID is also saved on the Ada conversation as booking_redirect_id.", isSubtle: true, size: "Small", wrap: true }
    ],
    actions: dashboard ? [{ type: "Action.OpenUrl", title: "Open Ada conversations", url: `${dashboard}/insights/conversations` }] : []
  };
  return JSON.stringify({ type: "message", attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", contentUrl: null, content: card }] });
}
__name(teamsBody, "teamsBody");
function post(name, url, body) {
  return fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body }).then(
    (r) => {
      console.log(`[relay] ${name} -> HTTP ${r.status}`);
      return r;
    },
    (e) => {
      console.log(`[relay] ${name} -> error ${e && e.message}`);
      throw e;
    }
  );
}
__name(post, "post");
var worker_default = {
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
    try {
      input = JSON.parse(body);
    } catch {
      return new Response("Bad JSON", { status: 400 });
    }
    const alert = {
      event: EVENTS.includes(input.event) ? input.event : "unknown",
      reason: clip(input.reason, 200),
      page: clip(input.page, 300),
      at: clip(input.at, 40),
      alert_id: clip(input.alert_id, 40) || crypto.randomUUID().slice(0, 8)
    };
    const now = Date.now();
    if (seenIds.has(alert.alert_id)) return new Response(null, { status: 204, headers: cors(origin) });
    seenIds.set(alert.alert_id, now);
    for (const [k, t] of seenIds) if (now - t > 36e5) seenIds.delete(k);
    if (rateLimited(origin, now)) return new Response("Rate limited", { status: 429, headers: cors(origin) });
    const sends = [];
    if (env.SLACK_WEBHOOK_URL) sends.push(post("slack", env.SLACK_WEBHOOK_URL, slackBody(env.SLACK_WEBHOOK_URL, slackMessage(alert, env.ADA_DASHBOARD_URL))));
    if (env.TEAMS_WEBHOOK_URL) sends.push(post("teams", env.TEAMS_WEBHOOK_URL, teamsBody(alert, env.ADA_DASHBOARD_URL)));
    ctx.waitUntil(Promise.allSettled(sends));
    return new Response(null, { status: 204, headers: cors(origin) });
  }
};
export {
  worker_default as default
};
//# sourceMappingURL=worker.js.map
