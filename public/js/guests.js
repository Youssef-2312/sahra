// Guests: /guests.html (owner and admin). Find a guest by name, email or ticket
// id and help them (resend the ticket, a new QR code, a name transfer, cancel);
// issue a ticket (complimentary or the guest list); write to guests (queued in
// Emails, sent only after approval). The numbers on top come from the same
// GET /api/party/stats as the dashboard, at most once a minute.
"use strict";
(function () {
  var t = Sahra.t, el = Sahra.el, S = SahraStaff;
  var stats = null, types = [], found = null, query = "", party = null;
  var ops = {};        // "action:ticket" -> op id, kept until the server confirms (a retry is the same change)
  var notes = {};      // ticket id -> [cls, text, link?]
  var open = {};       // ticket id -> which tool is open ("transfer")
  var drafts = { issue: null, announce: null };

  function opFor(key) { return ops[key] || (ops[key] = crypto.randomUUID()); }

  function statusOf(x) {
    if (x.used_at) return ["yes", t("g_st_inside")];
    if (x.status === "approved" && x.hold_at) return ["maybe", t("g_st_hold")];
    if (x.status === "approved") return x.released_at ? ["yes", t("g_st_sent")] : ["maybe", t("g_st_approved")];
    if (x.status === "pending") return ["maybe", t("g_st_pending")];
    if (x.status === "rejected") return ["no", t("g_st_rejected")];
    if (x.status === "cancelled") return ["no", t("g_st_cancelled")];
    return ["", x.status];
  }

  function tiles() {
    if (!stats) return null;
    var tile = function (label, big, sub) {
      return el("div", { class: "tile stat" }, el("div", { class: "label", text: label }), el("div", { class: "big", text: big }), sub ? el("div", { class: "sub muted", text: sub }) : null);
    };
    return el("div", { class: "tiles stats g-tiles" },
      tile(t("g_inside"), String(stats.inside), S.tn("g_inside_sub", stats.admitted_tickets)),
      tile(t("g_left"), String(stats.places_left), t("g_left_sub", { cap: stats.capacity })),
      tile(t("g_sent"), String(stats.released), t("g_sent_sub", { n: stats.approved })),
      tile(t("g_waiting"), String(stats.pending), t("g_waiting_sub")));
  }

  // ------------------------------------------------------------- find a guest

  async function search(q) {
    query = q;
    found = "loading";
    redrawFind();
    var r = await Sahra.api.get("/api/tickets/search?q=" + encodeURIComponent(q));
    found = r.ok ? r.body.tickets : { error: r };
    redrawFind();
  }

  async function run(x, action, body, confirmText) {
    if (confirmText && !window.confirm(confirmText)) return;
    var key = action + ":" + x.id;
    var path = "/api/tickets/" + encodeURIComponent(x.id) + "/" + action;
    var r = await S.act(path, action === "resend" ? {} : Object.assign({ op: opFor(key) }, body || {}));
    if (r.status !== 503) delete ops[key];
    var link = r.body && r.body.link ? location.origin + r.body.link : null;
    if (action === "resend") {
      notes[x.id] = r.ok ? ["yes", r.body.status === "queued" ? t("g_resent") : t("g_resent_already"), link]
        : r.body && r.body.error === "no_email" ? ["maybe", t("g_no_email"), link] : ["no", S.why(r)];
    } else if (!r.ok) {
      notes[x.id] = ["no", r.body && r.body.error === "not_allowed" ? t("g_not_allowed_" + action) : S.why(r)];
    } else {
      notes[x.id] = ["yes", t("g_done_" + action), link];
      delete open[x.id];
      if (query) await search(query);
    }
    redrawFind();
  }

  function guestRow(x) {
    var st = statusOf(x);
    var meta = [x.guest_email, x.type_name, x.people === 1 ? t("s_type_one") : t("s_type_exactly", { n: x.people })].filter(Boolean).join(" · ");
    var live = x.status === "pending" || x.status === "approved";
    var actions = el("div", { class: "g-actions" },
      live ? el("button", { class: "btn small-btn", text: t("g_resend"), attrs: { type: "button" }, on: { click: function () { run(x, "resend"); } } }) : null,
      x.status === "approved" && !x.used_at ? el("button", { class: "btn small-btn", text: t("g_reissue"), attrs: { type: "button" }, on: { click: function () { run(x, "reissue", null, t("g_reissue_confirm")); } } }) : null,
      live && !x.used_at ? el("button", { class: "btn small-btn", text: t("g_transfer"), attrs: { type: "button", "aria-expanded": open[x.id] ? "true" : "false" }, on: { click: function () { open[x.id] = open[x.id] ? null : "transfer"; redrawFind(); } } }) : null,
      live && !x.used_at ? el("button", { class: "btn no small-btn", text: t("g_cancel"), attrs: { type: "button" }, on: { click: function () { run(x, "cancel", null, t("g_cancel_confirm", { name: x.guest_name || x.id })); } } }) : null);
    var note = notes[x.id];
    var li = el("li", { class: "g-row" },
      el("div", { class: "g-who" },
        el("div", { class: "g-name-line" }, el("strong", { text: x.guest_name || t("g_no_name"), attrs: { dir: "auto" } }), el("span", { class: "pill " + st[0], text: st[1] })),
        el("span", { class: "muted small", text: meta, attrs: { dir: "auto" } }),
        el("span", { class: "faint small mono", text: Sahra.ref(x.id), attrs: { dir: "ltr" } })),
      actions);
    if (open[x.id] === "transfer") li.appendChild(transferForm(x));
    if (note) {
      var box = S.sayBox();
      S.say(box, note[0], note[1]);
      li.appendChild(el("div", { class: "g-note" }, box, note[2] ? el("div", { class: "g-link" }, el("code", { text: note[2], attrs: { dir: "ltr" } }), S.copyButton(note[2], t("g_copy_link"))) : null));
    }
    return li;
  }

  function transferForm(x) {
    var f = el("form", { class: "s-editor g-transfer", attrs: { novalidate: true } },
      el("p", { class: "small muted", text: t("g_transfer_h") }),
      el("div", { class: "s-two" },
        S.field(t("g_new_name"), S.input("name", "text", { maxlength: 80, required: true, dir: "auto" })),
        S.field(t("g_new_email"), S.input("email", "email", { placeholder: x.guest_email || "", dir: "ltr" }), t("g_new_email_h"))),
      el("div", { class: "s-save" }, el("button", { class: "btn primary small-btn", text: t("g_transfer_go"), attrs: { type: "submit" } })));
    f.addEventListener("submit", function (e) {
      e.preventDefault();
      var name = f.elements.name.value.trim();
      if (!name) { f.elements.name.focus(); return; }
      var body = { name: name };
      if (f.elements.email.value.trim()) body.email = f.elements.email.value.trim();
      run(x, "transfer", body);
    });
    return f;
  }

  var findNode = null;
  function findCard() {
    var input = S.input("q", "search", { minlength: 2, maxlength: 80, placeholder: t("g_search_ph"), value: query, autocomplete: "off", enterkeyhint: "search" });
    var f = el("form", { class: "g-search", attrs: { role: "search" } }, input, el("button", { class: "btn primary small-btn", text: t("g_search"), attrs: { type: "submit" } }));
    f.addEventListener("submit", function (e) {
      e.preventDefault();
      var q = input.value.trim();
      if (q.length >= 2) search(q);
    });
    var body;
    if (found === null) body = el("p", { class: "small muted", text: t("g_search_h") });
    else if (found === "loading") body = el("p", { class: "muted", text: t("loading") });
    else if (found.error) body = el("p", { class: "notice no", text: S.why(found.error) });
    else if (!found.length) body = el("p", { class: "s-empty muted", text: t("g_none", { q: query }) });
    else body = el("ul", { class: "g-list" }, found.map(guestRow));
    findNode = S.section("find", t("g_find"), null, f, body);
    return findNode;
  }
  function redrawFind() {
    if (!findNode || !findNode.parentNode) return;
    var hadFocus = document.activeElement && findNode.contains(document.activeElement) && document.activeElement.name === "q";
    var old = findNode;
    old.parentNode.replaceChild(findCard(), old);
    if (hadFocus) findNode.querySelector("input[name=q]").focus();
  }

  // ------------------------------------------------------------- issue a ticket

  function typeOptions(all) {
    return [["", all ? t("g_all_types") : t("g_no_type")]].concat(types.filter(function (x) { return !x.archived; }).map(function (x) {
      return [x.id, x.name + (x.staff_only ? " (" + t("s_staff_only") + ")" : "")];
    }));
  }

  function keep(f, which) {
    f.addEventListener("input", function () {
      var d = {};
      Array.prototype.forEach.call(f.elements, function (e) { if (e.name) d[e.name] = e.type === "checkbox" ? e.checked : e.value; });
      drafts[which] = d;
    });
    var d = drafts[which];
    if (d) Object.keys(d).forEach(function (k) { var e = f.elements[k]; if (!e) return; if (e.type === "checkbox") e.checked = d[k]; else e.value = d[k]; });
  }

  function issueCard() {
    var box = S.sayBox();
    var linkBox = el("div");
    var f = el("form", { attrs: { novalidate: true } },
      el("div", { class: "s-two" },
        S.field(t("g_name"), S.input("name", "text", { maxlength: 80, required: true, dir: "auto" })),
        S.field(t("g_email"), S.input("email", "email", { dir: "ltr" }), t("g_email_h"))),
      el("div", { class: "s-two" },
        S.field(t("g_people"), S.input("people", "number", { min: 1, max: 50, value: 1, inputmode: "numeric" })),
        types.length ? S.field(t("g_type"), S.select("type_id", typeOptions(false))) : null),
      S.check("complimentary", t("g_comp"), true, t("g_comp_h")),
      S.check("release", t("g_release"), true, t("g_release_h")),
      el("div", { class: "s-save" }, el("button", { class: "btn primary small-btn", text: t("g_issue_go"), attrs: { type: "submit" } }), box),
      linkBox);
    keep(f, "issue");
    f.addEventListener("submit", async function (e) {
      e.preventDefault();
      var name = f.elements.name.value.trim();
      if (!name) { S.say(box, "no", t("s_name_needed")); return; }
      var btn = f.querySelector("button[type=submit]");
      btn.disabled = true;
      S.say(box, "maybe", t("s_saving"));
      var r = await S.act("/api/tickets/issue", { op: opFor("issue"), name: name, email: f.elements.email.value.trim() || null,
        people: Number(f.elements.people.value || 1), type_id: f.elements.type_id ? f.elements.type_id.value || null : null,
        complimentary: f.elements.complimentary.checked, release: f.elements.release.checked });
      btn.disabled = false;
      if (r.status !== 503) delete ops.issue;
      Sahra.clear(linkBox);
      if (!r.ok) { S.say(box, "no", r.body && r.body.error === "not_allowed" ? t("g_issue_refused") : S.why(r)); return; }
      var link = location.origin + r.body.link;
      S.say(box, "yes", t("g_issued", { name: name }));
      linkBox.appendChild(el("div", { class: "g-link" }, el("code", { text: link, attrs: { dir: "ltr" } }), S.copyButton(link, t("g_copy_link"))));
      f.reset();
      drafts.issue = null;
      loadStats();
    });
    return S.section("issue", t("g_issue"), t("g_issue_p"), f);
  }

  // ------------------------------------------------------------- announcement

  function announceCard() {
    var box = S.sayBox();
    var f = el("form", { attrs: { novalidate: true } },
      S.field(t("s_subject"), S.input("subject", "text", { maxlength: 150, required: true, dir: "auto" })),
      S.field(t("g_message"), el("textarea", { attrs: { name: "body", maxlength: 3000, rows: 6, required: true, dir: "auto" } }), t("g_message_h")),
      el("div", { class: "s-two" },
        S.field(t("g_to"), S.select("audience", [["released", t("g_to_released")], ["approved", t("g_to_approved")], ["everyone", t("g_to_everyone")]])),
        types.length ? S.field(t("g_type"), S.select("type_id", typeOptions(true))) : null),
      el("div", { class: "s-save" }, el("button", { class: "btn primary small-btn", text: t("g_announce_go"), attrs: { type: "submit" } }), box));
    keep(f, "announce");
    f.addEventListener("submit", async function (e) {
      e.preventDefault();
      var subject = f.elements.subject.value.trim(), body = f.elements.body.value.trim();
      if (!subject || !body) { S.say(box, "no", t("g_announce_needed")); return; }
      var btn = f.querySelector("button[type=submit]");
      btn.disabled = true;
      S.say(box, "maybe", t("s_saving"));
      var r = await S.act("/api/party/announce", { op: opFor("announce"), subject: subject, body: body,
        audience: f.elements.audience.value, type_id: f.elements.type_id ? f.elements.type_id.value || null : null });
      btn.disabled = false;
      if (r.status !== 503) delete ops.announce;
      if (!r.ok) { S.say(box, "no", S.why(r)); return; }
      S.say(box, "yes", (r.body.queued ? S.tn("g_announced", r.body.queued) : t("g_announced_none")) +
        (r.body.not_queued ? " " + S.tn("g_not_queued", r.body.not_queued) : ""));
      f.reset();
      drafts.announce = null;
    });
    return S.section("announce", t("g_announce"), t("g_announce_p"), f,
      el("p", { class: "small" }, el("a", { text: t("g_open_outbox"), attrs: { href: "/outbox.html" } })));
  }

  // Guests let in by hand at the door (their QR would not scan), with who did it: for review.
  var manualAdmits = [];
  function manualCard() {
    if (!manualAdmits.length) return null;
    return S.section("manual", t("g_manual"), t("g_manual_p"),
      el("ul", { class: "s-list" }, manualAdmits.map(function (x) {
        return el("li", null,
          el("div", { class: "s-type-text" }, el("strong", { text: x.guest_name || t("g_no_name"), attrs: { dir: "auto" } }),
            el("span", { class: "muted small", text: t("g_manual_by", { time: Sahra.when(x.at), by: x.staff_name || t("g_unknown") }) })),
          el("span", { class: "small muted", text: S.tn("g_people_n", x.people) }));
      })));
  }

  function scanners() {
    if (!stats || !stats.by_scanner || !stats.by_scanner.length) return null;
    return S.section("scanners", t("g_scanners"), t("g_scanners_p"),
      el("ul", { class: "s-list" }, stats.by_scanner.map(function (x) {
        return el("li", null, el("span", { text: x.name || t("g_unknown"), attrs: { dir: "auto" } }), el("strong", { text: S.tn("g_people_n", x.people) }));
      })));
  }

  // ------------------------------------------------------------- page

  var tilesNode = null, scannersNode = null;
  function render(me, app) {
    tilesNode = tiles();
    if (tilesNode) app.appendChild(tilesNode);
    app.appendChild(el("div", { class: "g-cols" },
      el("div", { class: "g-main" }, findCard(), scannersNode = scanners(), manualCard()),
      el("div", { class: "g-side" }, issueCard(), announceCard())));
  }

  async function loadStats() {
    var r = await Sahra.api.get("/api/party/stats");
    if (!r.ok) return;
    stats = r.body;
    if (tilesNode && tilesNode.parentNode) { var n = tiles(); tilesNode.parentNode.replaceChild(n, tilesNode); tilesNode = n; }
  }

  var first = true;
  SahraStaff.start({
    page: "guests", title: "g_title", lede: "g_lede",
    render: function (me, app) {
      render(me, app);
      if (!first) return;
      first = false;
      Promise.all([Sahra.api.get("/api/party/stats"), Sahra.api.get("/api/tickets/types"), Sahra.api.get("/api/scan/manual")]).then(function (rs) {
        if (rs[2].ok) manualAdmits = rs[2].body.admits || [];
        if (rs[0].ok) stats = rs[0].body;
        if (rs[1].ok) types = rs[1].body.types || [];
        S.redraw();
        setInterval(function () { if (document.visibilityState === "visible") loadStats(); }, 60000);
      });
    },
  });
})();
