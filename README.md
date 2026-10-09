# MAS booking redirect — link launcher

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
