# MAS booking redirect

Static page for the Malaysia Airlines booking flow on the Ada sandbox.

Instead of the AI Agent firing a `flight_booking` / `express_booking` JavaScript
event into the host page, the agent sends the customer a link to `book.html`.
The link's fragment carries the form the booking page expects; `book.html`
rebuilds it and POSTs it when the customer taps the link. It works on any
channel that can show a link and keeps the chat open in the original tab.

## Link format

`https://jiapengchua.github.io/mas-redirect/book.html#j=<encodeURIComponent(JSON)>`

where the JSON is `{"post_url": "...", "method": "POST", "fields": {...}}`.
`#p=<base64url(JSON)>` is also accepted (same format as `sreac-relay.html` in
mas-sreac-pages). The fragment is never sent to a server, and the page removes
it from the address bar before submitting.

The page refuses to POST anywhere outside `ALLOWED_HOSTS`.

## Test page

`test.html` embeds the `malaysiaairlines-sandbox` bot **without** acting on the
`flight_booking` / `express_booking` / `flight_reaccommodation` events (it only
lists them), so the "tap here" booking link stays in the chat for testing.

## Booking redirect handler (for the MAS website)

`ada-booking-handler.js` handles the bot's handoff events and reports the outcome
back to Ada. To add it to a page that hosts the chat, load it **before** the Ada
embed:

```html
<script src="ada-booking-handler.js"></script>
<script id="__ada" data-handle="malaysiaairlines-sandbox" src="https://static.ada.support/embed2.js" async></script>
```

| Event | What the page does |
|---|---|
| `flight_booking` | POSTs the booking form to the URL Ada provides |
| `express_booking` | same, for express booking |
| `flight_reaccommodation` | sends the browser to the self-reaccommodation page |

It reports to Ada as metavariables on the conversation:

| Metavariable | Value |
|---|---|
| `booking_handler` | `ready` — set when the page loads, so Ada knows this page can redirect |
| `booking_redirect_status` | `submitted` or `failed` |
| `booking_redirect_event` | the event that fired |
| `booking_redirect_reason` | short reason on failure (no URL, not https, host not allowed, handler error) |
| `booking_redirect_at` | timestamp |

**Silent blocks.** After submitting, the handler also checks the redirect actually
happened. A site security policy with a `form-action` rule makes the browser block
the booking form without any error; the handler catches that from the browser's
`securitypolicyviolation` event and reports `blocked by the page's security policy
(form-action)`. If the browser simply never starts leaving the page within
`navigationTimeoutMs` (4 s), it reports `browser did not leave the page`. A slow
booking site does not trigger this: the browser has already started leaving.

**Simulating a failure.** `simulate-failure.html` is the demo page plus a
`form-action 'self'` security policy — a realistic change a site could make. Chat as
normal; when the bot hands off the booking, the browser blocks the form and the
failure path runs for real (notice, Ada metavariables, alert).

Edit `CONFIG` at the top of the script for production hosts (`bookingHosts`,
`sreacHosts`, `sreacEndpoint`) and to turn the on-page failure notice on or off
(`notifyCustomer`). The handler can only see failures before the browser leaves
the page; an error on the booking site itself is outside its view.

`index.html` is a demo page using it.

## Slack / Teams alerts for failed redirects

When `CONFIG.alertUrl` is set, the handler sends a `navigator.sendBeacon` to the
relay in `alert-relay/` on every failure. The relay (a Cloudflare Worker) checks
the sending site, rate-limits (20/min), drops duplicates, and posts to Slack, Microsoft
Teams, or both. The webhook URLs live only in the Worker as secrets.

Each alert carries an ID that is also saved on the Ada conversation as
`booking_redirect_id`, so the conversation can be found from the alert.

Deploy:

```bash
cd alert-relay
npx wrangler login                          # one-time, opens a browser
npx wrangler secret put SLACK_WEBHOOK_URL   # Slack webhook URL (optional)
npx wrangler secret put TEAMS_WEBHOOK_URL   # Teams Workflows URL (optional)
npx wrangler deploy                         # prints the Worker URL
```

Deployed: `https://mh-booking-redirect.mag-alerts.workers.dev` (Worker `mh-booking-redirect`;
one Worker per use case under the `mag-alerts` account subdomain). Watch deliveries with
`npx wrangler tail mh-booking-redirect`.

```bash
```

### Teams webhook

In the Teams channel: **⋯ → Workflows** → template **"Post to a channel when a
webhook request is received"** → confirm the team and channel → **Add workflow**,
then copy the URL it shows. (The older "Incoming Webhook" connector is retired.)
The relay posts an Adaptive Card. The tenant admin must allow the Workflows app.

Then set `alertUrl` in `ada-booking-handler.js` to the Worker URL, and list the
sites hosting the chat in `ALLOWED_ORIGINS` (`alert-relay/wrangler.toml`).

## Rolling out on MAS UAT

MAS UAT (`https://uat.malaysiaairlines.com`, including the app chatbot page) already
hosts the sandbox chat. To add the handler there:

1. MAS hosts a copy of `ada-booking-handler.js` on their UAT site, with
   `alertUrl` set to the deployed relay URL. The UAT booking and self-reaccommodation
   hosts are already in its `CONFIG`.
2. Load it **after** any existing `window.adaSettings` on the page and **before**
   `embed2.js`. It merges into existing settings and keeps their other options, but
   it replaces any existing `flight_booking` / `express_booking` /
   `flight_reaccommodation` callbacks.

   ```html
   <script src="/path/to/ada-booking-handler.js"></script>
   <script id="__ada" data-handle="malaysiaairlines-sandbox" src="https://static.ada.support/embed2.js" async></script>
   ```

3. `https://uat.malaysiaairlines.com` is already in the relay's `ALLOWED_ORIGINS`.
   For production, add `https://www.malaysiaairlines.com` there and switch the
   handler's hosts and endpoint to production.
