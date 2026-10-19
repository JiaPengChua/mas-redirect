/*
  Ada booking redirect handler — with failure reporting.

  Add this script to every page that hosts the Ada chat, BEFORE the Ada embed
  script (embed2.js), so window.adaSettings is in place when the chat starts.

  What it does
  - Tells Ada the page can redirect: sets the metavariable booking_handler = "ready".
  - Handles the handoff events the bot fires:
      flight_booking          -> POSTs the booking form (normal booking)
      express_booking         -> POSTs the booking form (express booking)
      flight_reaccommodation  -> sends the browser to the self-reaccommodation page
  - Reports every outcome back to Ada as metavariables on the conversation:
      booking_redirect_status  "submitted" | "failed"
      booking_redirect_event   which event fired
      booking_redirect_reason  short, non-sensitive reason (only on failure)
      booking_redirect_at      ISO timestamp
    and logs to the browser console.

  It can only report what happens BEFORE the browser leaves the page. An error
  shown by the booking site itself is outside its view.
*/
(function () {
  "use strict";

  /* ------------------------------------------------------------- CONFIG */
  var CONFIG = {
    // Hosts the booking form may be POSTed to. Anything else is refused and reported.
    bookingHosts: [
      "uat.digital.airline.amadeus.com",
      "digital.airline.amadeus.com",
      "uat-book.malaysiaairlines.com",
      "book.malaysiaairlines.com",
    ],
    // Hosts the self-reaccommodation redirect may go to.
    sreacHosts: ["sandbox-api.malaysiaairlines.com", "api.malaysiaairlines.com"],
    sreacEndpoint: "https://sandbox-api.malaysiaairlines.com/refx/sreac/redirection/",
    // Ada variables that steer the redirect rather than being sent to the booking page.
    controlKeys: ["url", "method", "platform"],
    // Show the customer a small notice on the page when a redirect fails.
    notifyCustomer: true,
    // How long to wait for Ada to record the outcome before navigating away (ms).
    reportTimeoutMs: 1500,
    // Alert relay that forwards failures to Slack/Teams (see alert-relay/). null = alerts off.
    alertUrl: null,
    // After submitting, how long to wait for the browser to start leaving the page (ms).
    // If it hasn't, something silently blocked the redirect (e.g. a security policy).
    navigationTimeoutMs: 4000,
  };

  /* ------------------------------------------------------------ REPORTING */
  function report(eventName, status, reason) {
    var fields = {
      booking_redirect_status: status,
      booking_redirect_event: eventName,
      booking_redirect_reason: reason || "",
      booking_redirect_at: new Date().toISOString(),
      booking_redirect_id: newAlertId(),
    };
    (status === "failed" ? console.error : console.log)("[ada-booking] " + eventName + " " + status + (reason ? ": " + reason : ""));
    if (status === "failed") alertSlack(fields);

    var send;
    try {
      send = window.adaEmbed && window.adaEmbed.setMetaFields
        ? Promise.resolve(window.adaEmbed.setMetaFields(fields))
        : Promise.reject(new Error("adaEmbed.setMetaFields unavailable"));
    } catch (err) {
      send = Promise.reject(err);
    }
    var timeout = new Promise(function (resolve) { setTimeout(resolve, CONFIG.reportTimeoutMs); });
    return Promise.race([send, timeout]).catch(function (err) {
      console.warn("[ada-booking] could not report to Ada:", err && err.message);
    });
  }

  function newAlertId() {
    return Math.random().toString(36).slice(2, 10);
  }

  // Fire-and-forget: sendBeacon survives page navigation and needs no CORS preflight.
  function alertSlack(fields) {
    if (!CONFIG.alertUrl || !navigator.sendBeacon) return;
    try {
      var body = JSON.stringify({
        event: fields.booking_redirect_event,
        reason: fields.booking_redirect_reason,
        at: fields.booking_redirect_at,
        alert_id: fields.booking_redirect_id,
        page: location.origin + location.pathname,
      });
      navigator.sendBeacon(CONFIG.alertUrl, new Blob([body], { type: "text/plain" }));
    } catch (err) {
      console.warn("[ada-booking] could not send alert:", err && err.message);
    }
  }

  function notify(message) {
    if (!CONFIG.notifyCustomer) return;
    var box = document.getElementById("ada-booking-notice") || document.createElement("div");
    box.id = "ada-booking-notice";
    box.setAttribute("role", "alert");
    box.style.cssText = "position:fixed;left:16px;right:16px;bottom:16px;max-width:420px;margin:0 auto;z-index:2147483646;" +
      "background:#b3261e;color:#fff;padding:12px 16px;border-radius:8px;font:14px/1.4 sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.25)";
    box.textContent = message;
    document.body.appendChild(box);
    setTimeout(function () { box.remove(); }, 10000);
  }

  function fail(eventName, reason) {
    notify("Sorry, we couldn't open the booking page. Please try again, or ask the chat for help.");
    return report(eventName, "failed", reason);
  }

  /* -------------------------------------------------------------- HELPERS */
  function globalsOf(event) {
    return (event && event.user_data && event.user_data.global) || {};
  }

  function checkUrl(url, allowedHosts) {
    if (!url || url === "NONE") return "no URL from Ada";
    var parsed;
    try { parsed = new URL(url); } catch (e) { return "URL is not valid"; }
    if (parsed.protocol !== "https:") return "URL is not https";
    if (allowedHosts.indexOf(parsed.hostname) === -1) return "host not allowed: " + parsed.hostname;
    return null;
  }

  function postForm(method, action, fields) {
    var form = document.createElement("form");
    form.method = method;
    form.action = action;
    form.target = "_self";
    form.style.display = "none";
    Object.keys(fields).forEach(function (key) {
      var value = fields[key];
      if (value === undefined || value === null) return;
      var input = document.createElement("input");
      input.type = "hidden";
      input.name = key;
      input.value = typeof value === "string" ? value : JSON.stringify(value);
      form.appendChild(input);
    });
    document.body.appendChild(form);
    form.submit();
  }

  // Starts the navigation, then checks nothing silently blocked it.
  // - A Content Security Policy `form-action` rule blocks the booking form without throwing; the
  //   browser only fires a `securitypolicyviolation` event (and Chrome still fires `beforeunload`
  //   first). That event is reported at once.
  // - Otherwise, if the browser never starts leaving the page within navigationTimeoutMs, report it.
  //   A slow booking site is fine: the browser has already started leaving.
  // Errors on the booking site after the page has gone are out of reach.
  function navigateAndWatch(eventName, start) {
    var left = false;
    var done = false;
    function markLeft() { left = true; }
    function finish(reason) {
      if (done) return;
      done = true;
      window.removeEventListener("beforeunload", markLeft);
      window.removeEventListener("pagehide", markLeft);
      document.removeEventListener("securitypolicyviolation", onViolation);
      if (reason) fail(eventName, reason);
    }
    function onViolation(e) {
      var directive = String(e.effectiveDirective || e.violatedDirective || "");
      if (directive.indexOf("form-action") === 0) {
        finish("blocked by the page's security policy (form-action)");
      }
    }
    window.addEventListener("beforeunload", markLeft);
    window.addEventListener("pagehide", markLeft);
    document.addEventListener("securitypolicyviolation", onViolation);
    start();
    setTimeout(function () { finish(left ? null : "browser did not leave the page"); }, CONFIG.navigationTimeoutMs);
  }

  /* ------------------------------------------------------------- HANDLERS */
  function handleBooking(eventName, event) {
    try {
      var globals = globalsOf(event);
      var problem = checkUrl(globals.url, CONFIG.bookingHosts);
      if (problem) return fail(eventName, problem);

      var fields = {};
      Object.keys(globals).forEach(function (key) {
        if (CONFIG.controlKeys.indexOf(key) === -1) fields[key] = globals[key];
      });
      var method = String(globals.method || "post").toUpperCase();

      // Record "submitted" first: once the form submits, this page is gone.
      return report(eventName, "submitted").then(function () {
        navigateAndWatch(eventName, function () { postForm(method, globals.url, fields); });
      });
    } catch (err) {
      return fail(eventName, "handler error: " + (err && err.message));
    }
  }

  function handleSreac(event) {
    var eventName = "flight_reaccommodation";
    try {
      var globals = globalsOf(event);
      var supplied = globals.sreac_action;
      var url = supplied && supplied !== "NONE" && supplied.indexOf("{{") === -1 ? supplied : null;
      if (!url) {
        if (!globals.pnr || !globals.lastName) return fail(eventName, "no sreac_action and no pnr/lastName");
        url = CONFIG.sreacEndpoint + "?" + new URLSearchParams({
          identifier: globals.pnr, lastName: globals.lastName, lang: globals.lang || "en-GB",
        }).toString();
      }
      var problem = checkUrl(url, CONFIG.sreacHosts);
      if (problem) return fail(eventName, problem);
      return report(eventName, "submitted").then(function () {
        navigateAndWatch(eventName, function () { window.location.href = url; });
      });
    } catch (err) {
      return fail(eventName, "handler error: " + (err && err.message));
    }
  }

  /* --------------------------------------------------------- ADA SETTINGS */
  var settings = window.adaSettings || {};
  settings.metaFields = Object.assign({}, settings.metaFields, { booking_handler: "ready" });
  settings.eventCallbacks = Object.assign({}, settings.eventCallbacks, {
    flight_booking: function (event) { return handleBooking("flight_booking", event); },
    express_booking: function (event) { return handleBooking("express_booking", event); },
    flight_reaccommodation: handleSreac,
  });
  window.adaSettings = settings;

  // Exposed for testing in the browser console.
  window.adaBookingHandler = { handleBooking: handleBooking, handleSreac: handleSreac, config: CONFIG };
})();
