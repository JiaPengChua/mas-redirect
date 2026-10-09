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

Edit `CONFIG` at the top of the script for production hosts (`bookingHosts`,
`sreacHosts`, `sreacEndpoint`) and to turn the on-page failure notice on or off
(`notifyCustomer`). The handler can only see failures before the browser leaves
the page; an error on the booking site itself is outside its view.

`index.html` is a demo page using it.
