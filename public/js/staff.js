// Shared parts of the staff pages (owner and admin): load after i18n.js,
// i18n-staff.js and ui.js. Exposes one global: SahraStaff.
//
//   SahraStaff.start({ page, render, owner })  signs in (door staff go to the scanner), boots
//                                               the top bar and footer, draws the page head
//                                               and the staff menu; render(me) draws the rest
//   SahraStaff.act(path, body)                  POST, repeated with the same body while the
//                                               answer is "pending" (503): every staff action
//                                               is safe to repeat
//   SahraStaff.field(label, control, hint)      a labelled form field
//   SahraStaff.section(id, title, intro, ...)   a settings card
//   SahraStaff.say(node, cls, text)             the answer under a form ("yes", "no", "maybe")
//   SahraStaff.local(ms, tz)                    an instant as a datetime-local value in the party's zone
//
// Every rule is checked by the server; these pages only show its answer.
"use strict";
var SahraStaff = (function () {
  var t = Sahra.t, el = Sahra.el;
  var PAGES = [
    ["dashboard", "/dashboard.html", "s_nav_dashboard"],
    ["queue", "/queue.html", "s_nav_queue"],
    ["guests", "/guests.html", "s_nav_guests"],
    ["settings", "/party.html", "s_nav_settings"],
    ["outbox", "/outbox.html", "s_nav_outbox"],
    ["team", "/tools.html", "s_nav_team", "owner"],
  ];

  var current = null;
  /** Draws the page again (after its data arrives, or a change elsewhere on it). */
  function redraw() { if (current) current(); }

  function sleep(ms) { return new Promise(function (ok) { setTimeout(ok, ms); }); }

  async function act(path, body) {
    var r;
    for (var i = 0; i < 5; i++) {
      r = await Sahra.api.post(path, body);
      if (r.status !== 503 || !(r.body && (r.body.retry || r.body.status === "pending"))) break;
      await sleep(1500);
    }
    return r;
  }

  // One sign-in: an account that also has My parties (a party owner who creates
  // parties, or the site owner) gets a link back there, and signing out ends both.
  var platform; // undefined: not asked yet; null: none
  function myParties() { return el("a", { class: "staff-mine", text: t("p_my_parties"), attrs: { href: "/platform" } }); }
  async function askPlatform() {
    platform = null;
    var r = await Sahra.api.get("/api/platform/me");
    if (!r.ok) return;
    platform = r.body;
    document.querySelectorAll(".staff-nav").forEach(function (n) { if (!n.querySelector(".staff-mine")) n.insertBefore(myParties(), n.firstChild); });
  }

  async function signOut() {
    await Sahra.api.post("/api/auth/logout");
    if (platform) await Sahra.api.post("/api/platform/logout", {}, { "x-sahra-csrf": platform.csrf });
    Sahra.store.del(Sahra.SESSION_KEY);
    location.href = "/";
  }

  /** The staff menu: one row of links, the current page marked. */
  function nav(current, role) {
    if (platform === undefined && role !== "door") askPlatform();
    return el("nav", { class: "staff-nav", attrs: { "aria-label": t("s_nav_label") } }, platform ? myParties() : null,
      PAGES.filter(function (p) { return !p[3] || p[3] === role; }).map(function (p) {
        return el("a", { text: t(p[2]), attrs: { href: p[1], "aria-current": p[0] === current ? "page" : null } });
      }), el("button", { class: "staff-out", text: t("s_sign_out"), attrs: { type: "button" }, on: { click: signOut } }));
  }

  function head(o) {
    return el("header", { class: "staff-head" },
      el("div", null,
        el("p", { class: "label-line", text: o.party }),
        el("h1", { text: o.title }),
        o.lede ? el("p", { class: "muted lede", text: o.lede }) : null),
      o.actions ? el("div", { class: "dash-actions" }, o.actions) : null);
  }

  /**
   * Opens a staff page. opts: page (menu key), title / lede (i18n keys), render(me, app),
   * owner (owners only). Returns the signed-in person, or null.
   */
  async function start(opts) {
    var app = document.getElementById("app");
    var me = await Sahra.api.me();
    if (me && me.staff.role === "door") { location.href = "/scan.html"; return null; }
    current = draw;
    function draw() {
      Sahra.clear(app);
      app.classList.add("staff");
      Sahra.title(t(opts.title));
      if (!me) {
        app.appendChild(Sahra.problem({ kicker: t("nt_kicker_signin"), title: t("nt_staff_t"), text: t("d_sign_in"),
          actions: [[t("sign_in"), "/signin", true], [t("nt_home"), "/"]], hint: t("nt_guest_hint") }));
        return;
      }
      var menu = nav(opts.page, me.staff.role);
      app.appendChild(menu);
      // On a phone the menu scrolls sideways: bring the current page into view.
      var cur = menu.querySelector("[aria-current]");
      if (cur && menu.scrollWidth > menu.clientWidth) {
        var rtl = document.documentElement.dir === "rtl";
        menu.scrollLeft = rtl ? -(menu.clientWidth - cur.offsetLeft - cur.offsetWidth) + 0 : Math.max(0, cur.offsetLeft - 16);
      }
      if (opts.owner && me.staff.role !== "owner") {
        app.appendChild(head({ party: me.party.name, title: t(opts.title) }));
        app.appendChild(el("p", { class: "notice info", text: t("s_owner_only") }));
        return;
      }
      app.appendChild(head({ party: me.party.name, title: t(opts.title), lede: opts.lede ? t(opts.lede) : null,
        actions: opts.actions ? opts.actions(me) : null }));
      opts.render(me, app);
    }
    Sahra.boot({ render: draw, me: me });
    return me;
  }

  function field(label, control, hint, cls) {
    var id = control.id || ("f-" + Math.random().toString(36).slice(2, 9));
    control.id = id;
    return el("div", { class: "field" + (cls ? " " + cls : "") },
      el("label", { text: label, attrs: { for: id } }), control,
      hint ? el("span", { class: "hint", text: hint }) : null);
  }

  function input(name, type, attrs) {
    return el(type === "textarea" ? "textarea" : "input", { attrs: Object.assign({ name: name, type: type === "textarea" ? null : type || "text" }, attrs || {}) });
  }

  function select(name, options, value) {
    var s = el("select", { attrs: { name: name } }, options.map(function (o) {
      return el("option", { text: o[1], attrs: { value: o[0] } });
    }));
    if (value !== undefined && value !== null) s.value = value;
    return s;
  }

  function check(name, label, checked, hint) {
    var box = el("input", { attrs: { type: "checkbox", name: name } });
    box.checked = box.defaultChecked = !!checked;
    return el("label", { class: "check" }, box, el("span", null, el("span", { text: label }),
      hint ? el("span", { class: "hint", text: hint }) : null));
  }

  function section(id, title, intro) {
    var s = el("section", { class: "card s-card", attrs: { id: id, "aria-labelledby": id + "-h" } },
      el("div", { class: "s-card-head" }, el("h2", { text: title, attrs: { id: id + "-h" } }),
        intro ? el("p", { class: "muted", text: intro }) : null));
    for (var i = 3; i < arguments.length; i++) if (arguments[i]) s.appendChild(arguments[i]);
    return s;
  }

  /** The answer under a form; an empty text clears it. */
  // A success line goes away by itself (owner: about 3 seconds; a long one a little
  // later so it can be read); errors and warnings stay until the next action.
  function sayMs(text) { return Math.min(8000, 3000 + Math.max(0, String(text).length - 40) * 50); }
  function say(node, cls, text) {
    clearTimeout(node._sayTimer);
    node.className = "say" + (text ? " " + cls : "");
    node.textContent = text || "";
    node.setAttribute("role", cls === "no" ? "alert" : "status");
    if (text && cls === "yes") {
      node._sayTimer = setTimeout(function () {
        if (node.textContent === text) { node.className = "say"; node.textContent = ""; }
      }, sayMs(text));
    }
  }
  function sayBox() { return el("p", { class: "say", attrs: { role: "status", "aria-live": "polite" } }); }

  var FIELD_LABELS = { name: "s_name", description: "s_description", venue_name: "s_venue", address: "s_address", map_url: "s_map",
    rules: "s_entry_rules", cancellation_policy: "s_cancellation", payment_instructions: "s_payment", capacity: "s_capacity",
    starts_at: "s_starts", ends_at: "s_ends", registration_closes_at: "s_closes",
    max_people_per_ticket: "s_people", review_time: "s_review_time", support_phone: "s_contact_phone", support_email: "s_contact_email" };

  /** Words for a refused staff action: the server's code when known, else a general line. */
  function why(r) {
    if (r.status === 503) return t("s_not_confirmed");
    var code = r.body && r.body.error;
    if (typeof code === "string") {
      var k = code.indexOf("invalid_field:") === 0 ? (SahraText.en["e_" + code.replace(":", "_")] ? "e_" + code.replace(":", "_") : "e_invalid_field")
        : code.indexOf("in_the_past:") === 0 ? "e_in_the_past" : "e_" + code;
      // The field by its label on the page ("Entry rules and dress code"), not its code name.
      var f = code.split(":")[1] || "", label = FIELD_LABELS[f];
      if (SahraText.en[k]) return t(k, { field: label ? t(label) : f, held: r.body.held, max: r.body.max });
    }
    return Sahra.errorText(r);
  }

  /** Instant (UTC ms) to the value of a datetime-local input in the party's zone. */
  function local(ms, tz) {
    if (ms === null || ms === undefined || !tz) return "";
    var p = {};
    new Intl.DateTimeFormat("en-GB", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      .formatToParts(ms).forEach(function (x) { p[x.type] = x.value; });
    return p.year + "-" + p.month + "-" + p.day + "T" + p.hour + ":" + p.minute;
  }

  /** A counted line: the "_1" wording for one when there is one ("1 email", not "1 emails"). */
  function tn(key, n, vars) {
    var k = n === 1 && SahraText.en[key + "_1"] ? key + "_1" : key;
    return t(k, Object.assign({ n: n }, vars || {}));
  }

  /** A button that copies a text and says so. */
  function copyButton(text, label) { return Sahra.copyButton(text, label || t("s_copy")); }

  return { start: start, act: act, field: field, input: input, select: select, check: check, section: section,
    say: say, sayMs: sayMs, sayBox: sayBox, why: why, local: local, copyButton: copyButton, sleep: sleep, nav: nav, redraw: redraw, tn: tn };
})();
