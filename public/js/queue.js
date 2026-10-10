// Approval queue: /queue.html (owner and admin). One card per request with the
// main action obvious (brainstorm ideas 10 and 11): "Approve and send QR" does
// both in one tap (approve, then release); "Approve only" and "Reject" sit
// beside it. Tabs: Waiting / Approved / Rejected. Several requests can be
// selected and handled together (up to 20 at a time, the server's limit).
//
// Every rule (party full, type full, request changed) is checked by the server
// in the same statement as the change; this page only shows the answer. A
// pending answer (503) is retried with the same body: approving, rejecting and
// sending are safe to repeat ("already" comes back for work that was done).
"use strict";
(function () {
  var t = Sahra.t, el = Sahra.el;
  var app = document.getElementById("app");
  var MAX = 20;
  var TABS = [["pending", "q_waiting"], ["approved", "q_approved"], ["rejected", "q_rejected"]];
  var me = null, tab = "pending", rows = null, next = null, failed = null, cashOnly = false;
  var selected = {};              // id -> true
  var notes = {};                 // id -> { cls, text }: the answer shown on a card after an action
  var bulkNote = null;
  var busy = false;

  function sleep(ms) { return new Promise(function (ok) { setTimeout(ok, ms); }); }
  async function post(path, body) {
    var r;
    for (var i = 0; i < 5; i++) {
      r = await Sahra.api.post(path, body);
      if (r.status !== 503 || !(r.body && r.body.retry)) break;
      await sleep(1500);
    }
    return r;
  }
  function ok(v) { return v === "done" || v === "already"; }

  // --- actions -------------------------------------------------------------

  /** Approve (and optionally send) a list of ids; returns { id: note }. */
  async function approve(ids, send) {
    var out = {};
    var a = await post("/api/tickets/approve", { ids: ids });
    if (!a.ok) { ids.forEach(function (id) { out[id] = { cls: "no", text: a.status === 503 ? t("not_confirmed") : Sahra.errorText(a) }; }); return out; }
    var approved = ids.filter(function (id) { return ok(a.body.results[id]); });
    ids.forEach(function (id) { out[id] = approved.indexOf(id) >= 0 ? { cls: "yes", text: t("q_done_approved"), state: "approved" } : { cls: "no", text: t("q_refused") }; });
    if (!send || !approved.length) return out;
    var r = await post("/api/tickets/release", { ids: approved });
    approved.forEach(function (id) {
      out[id] = r.ok && ok(r.body.results[id])
        ? { cls: "yes", text: t("q_done_sent"), state: "sent" }
        : { cls: "maybe", text: t("q_approved_not_sent"), state: "approved" };
    });
    return out;
  }
  async function release(ids) {
    var out = {};
    var r = await post("/api/tickets/release", { ids: ids });
    ids.forEach(function (id) {
      out[id] = r.ok && ok(r.body.results[id]) ? { cls: "yes", text: t("q_sent"), state: "sent" }
        : { cls: "no", text: r.ok ? t("q_refused") : r.status === 503 ? t("not_confirmed") : Sahra.errorText(r) };
    });
    return out;
  }
  async function reject(ids, reason) {
    var out = {};
    var r = await post("/api/tickets/reject", { ids: ids, reason: reason || null });
    ids.forEach(function (id) {
      out[id] = r.ok && ok(r.body.results[id]) ? { cls: "yes", text: t("q_rejected_done"), state: "rejected" }
        : { cls: "no", text: r.ok ? t("q_refused") : r.status === 503 ? t("not_confirmed") : Sahra.errorText(r) };
    });
    return out;
  }

  async function run(ids, fn) {
    if (busy || !ids.length) return;
    busy = true;
    render();
    var out = await fn(ids);
    busy = false;
    Object.keys(out).forEach(function (id) {
      notes[id] = out[id];
      delete selected[id];
      var row = rows && rows.filter(function (x) { return x.id === id; })[0];
      if (row && out[id].state === "sent") row.released_at = Date.now();
    });
    if (ids.length > 1) {
      var done = ids.filter(function (id) { return out[id].cls !== "no"; }).length;
      bulkNote = { cls: done === ids.length ? "yes" : "maybe", text: t("q_bulk_done", { done: done, refused: ids.length - done }) };
    }
    render();
  }

  // --- screenshot ----------------------------------------------------------

  // The image comes from an authenticated endpoint; shown as a data: URL (the page policy allows data: images).
  // `what`: "screenshot" or "id-photo" (the ID photo when the party's form asks for one).
  async function showShot(id, box, button, what) {
    what = what || "screenshot";
    button.disabled = true;
    var r;
    try { r = await fetch("/api/tickets/" + encodeURIComponent(id) + "/" + what, { credentials: "same-origin" }); } catch (e) { r = null; }
    if (!r || !r.ok) {
      button.remove();
      box.appendChild(el("p", { class: "small muted", text: r && r.status === 410 ? t(what === "id-photo" ? "q_id_gone" : "q_shot_gone") : t("error_generic") }));
      return;
    }
    var reader = new FileReader();
    reader.onload = function () { button.remove(); box.appendChild(el("img", { attrs: { src: reader.result, alt: t(what === "id-photo" ? "q_show_id" : "q_show_shot") } })); };
    reader.readAsDataURL(await r.blob());
  }

  // --- cards ---------------------------------------------------------------

  function people(n) { return n === 1 ? t("one_person") : t("q_people", { n: n }); }

  function rejectForm(row, actions) {
    var ids = row.ids || [row.id];
    Sahra.clear(actions);
    var input = el("input", { attrs: { type: "text", maxlength: 300, dir: "auto", "aria-label": t("q_reject_reason"), placeholder: t("q_reject_reason") } });
    actions.appendChild(el("div", { class: "main" }, input));
    actions.appendChild(el("button", { class: "btn", text: t("q_cancel"), attrs: { type: "button" }, on: { click: render } }));
    actions.appendChild(el("button", { class: "btn no", text: t("q_reject_confirm"), attrs: { type: "button" },
      on: { click: function () { run(ids, function (ids) { return reject(ids, input.value.trim()); }); } } }));
    input.focus();
  }

  // Tickets requested together (an order, migrations/0022) share one card: the first
  // ticket's details (proof, answers), every ticket's name, and actions on all of them.
  function grouped(list) {
    var out = [], byOrder = {};
    list.forEach(function (r) {
      if (!r.order_id) { out.push(r); return; }
      var g = byOrder[r.order_id];
      if (!g) { g = byOrder[r.order_id] = Object.assign({}, r, { members: [] }); out.push(g); }
      g.members.push(r);
      if (r.id === r.order_id) { var keep = g.members; Object.assign(g, r); g.members = keep; }
    });
    out.forEach(function (g) { if (g.members) g.ids = g.members.map(function (m) { return m.id; }); });
    return out;
  }

  function card(row) {
    var ids = row.ids || [row.id];
    var note = notes[row.id];
    var finished = note && note.cls !== "no" && (note.state === "sent" || note.state === "rejected" || (tab === "pending" && note.state === "approved" && note.cls === "yes"));
    var canSelect = !finished && (tab === "pending" || (tab === "approved" && !row.released_at));
    var box = canSelect ? el("input", { attrs: { type: "checkbox", "aria-label": t("q_select") },
      on: { change: function (e) { ids.forEach(function (id) { if (e.target.checked) selected[id] = true; else delete selected[id]; }); render(); } } }) : null;
    if (box) box.checked = ids.every(function (id) { return !!selected[id]; });

    var shot = el("div", { class: "shot" });
    if (row.has_screenshot) {
      var sb = el("button", { class: "btn link", text: t("q_show_shot"), attrs: { type: "button" } });
      sb.addEventListener("click", function () { showShot(row.id, shot, sb); });
      shot.appendChild(sb);
    } else if (row.price) {
      shot.appendChild(el("p", { class: "small muted", text: t("q_no_shot") }));
    }
    // Each ticket's own ID photo; for an order, one button per ticket that has one (the friends' too).
    var withId = (row.members || [row]).filter(function (m) { return m.has_id_photo; });
    withId.forEach(function (m) {
      var ib = el("button", { class: "btn link", text: withId.length > 1 || row.members ? t("q_show_id_of", { name: m.guest_name || "-" }) : t("q_show_id"), attrs: { type: "button" } });
      ib.addEventListener("click", function () { showShot(m.id, shot, ib, "id-photo"); });
      shot.appendChild(ib);
    });

    var answers = Object.keys(row.answers || {});
    var details = el("details", null, el("summary", { text: t("q_details") }),
      el("ul", { class: "facts" },
        row.guest_email ? el("li", null, el("span", { class: "muted", text: t("q_email") + ": " }), el("span", { text: row.guest_email, attrs: { dir: "ltr" } })) : null,
        row.instagram ? el("li", null, el("span", { class: "muted", text: t("insta_label") + ": " }),
          el("a", { text: "@" + row.instagram, attrs: { href: "https://www.instagram.com/" + encodeURIComponent(row.instagram) + "/", target: "_blank", rel: "noopener noreferrer", dir: "ltr" } })) : null,
        el("li", { class: "muted", text: t("q_requested", { when: Sahra.rel(row.created_at) }) }),
        ids.length > 1 ? row.members.map(function (m, i) {
          return el("li", null, el("span", { class: "muted", text: t("ticket_n", { n: i + 1 }) + ": " }), el("span", { text: m.guest_name || "-", attrs: { dir: "auto" } }));
        }) : null,
        answers.map(function (k) {
          return el("li", null, el("span", { class: "muted", text: k + ": ", attrs: { dir: "auto" } }), el("span", { class: "pre", text: String(row.answers[k]), attrs: { dir: "auto" } }));
        })));

    var actions = el("div", { class: "actions" });
    if (!finished && !busy) {
      if (tab === "pending") {
        actions.appendChild(el("button", { class: "btn primary main", text: t("q_approve_send"), attrs: { type: "button" },
          on: { click: function () { run(ids, function (ids) { return approve(ids, true); }); } } }));
        actions.appendChild(el("button", { class: "btn", text: t("q_approve"), attrs: { type: "button" },
          on: { click: function () { run(ids, function (ids) { return approve(ids, false); }); } } }));
        actions.appendChild(el("button", { class: "btn no", text: t("q_reject"), attrs: { type: "button" }, on: { click: function () { rejectForm(row, actions); } } }));
      } else if (tab === "approved" && !row.released_at) {
        actions.appendChild(el("button", { class: "btn primary main", text: t("q_send"), attrs: { type: "button" },
          on: { click: function () { run(ids, release); } } }));
      }
    }
    // After "Approve and send" failed to send: offer Send QR on the same card.
    if (tab === "pending" && note && note.cls === "maybe" && !busy) {
      actions.appendChild(el("button", { class: "btn primary main", text: t("q_send"), attrs: { type: "button" },
        on: { click: function () { run(ids, release); } } }));
    }

    var status = tab === "approved" ? el("span", { class: "pill " + (row.released_at ? "yes" : "maybe"), text: row.released_at ? t("q_sent") : t("q_approved") })
      : tab === "rejected" ? el("span", { class: "pill no", text: t("q_rejected") }) : null;

    return el("article", { class: "req" + (finished ? " done" : "") },
      el("div", { class: "head" },
        el("label", { class: "check" }, box,
          el("span", null, el("span", { class: "who", text: row.guest_name || "-", attrs: { dir: "auto" } }), el("br"),
            el("span", { class: "small muted", text: [ids.length > 1 ? t("q_n_tickets", { n: ids.length }) : null, row.type_name, people(row.people)].filter(Boolean).join(" · "), attrs: { dir: "auto" } }), el("br"),
            el("span", { class: "small faint mono", text: Sahra.ref(row.id), attrs: { dir: "ltr" } }))),
        status),
      row.price ? el("p", { class: "price", text: t("q_expected", { amount: Sahra.amount((row.total != null ? row.total : row.price * row.people) * ids.length) }) }) : null,
      row.payment === "cash" ? el("p", null, el("span", { class: "pill", text: t("q_paid_cash") })) : null,
      row.same_email ? el("p", { class: "notice maybe small", text: t("q_same_email", { n: row.same_email }) }) : null,
      tab === "rejected" && row.reject_reason ? el("p", { class: "small muted", text: t("q_reason", { reason: row.reject_reason }), attrs: { dir: "auto" } }) : null,
      shot, details,
      note ? el("p", { class: "notice " + note.cls, text: note.text }) : null,
      actions.firstChild ? actions : null);
  }

  // --- page ----------------------------------------------------------------

  function bulkbar() {
    var ids = Object.keys(selected);
    if (!ids.length || tab === "rejected") return null;
    var over = ids.length > MAX;
    var list = [el("span", { class: "small", text: t("q_selected", { n: ids.length }) })];
    if (over) list.push(el("span", { class: "small notice maybe", text: t("q_max", { n: MAX }) }));
    var dis = busy || over;
    if (tab === "pending") {
      list.push(el("button", { class: "btn primary small-btn", text: t("q_approve_send"), attrs: { type: "button", disabled: dis },
        on: { click: function () { run(ids, function (x) { return approve(x, true); }); } } }));
      list.push(el("button", { class: "btn small-btn", text: t("q_approve"), attrs: { type: "button", disabled: dis },
        on: { click: function () { run(ids, function (x) { return approve(x, false); }); } } }));
      list.push(el("button", { class: "btn no small-btn", text: t("q_reject"), attrs: { type: "button", disabled: dis },
        on: { click: async function () {
          var reason = await Sahra.ask(t("q_reject_reason"), { ok: t("q_reject") });
          if (reason === null) return;
          run(ids, function (x) { return reject(x, reason.trim()); });
        } } }));
    } else {
      list.push(el("button", { class: "btn primary small-btn", text: t("q_send"), attrs: { type: "button", disabled: dis }, on: { click: function () { run(ids, release); } } }));
    }
    list.push(el("button", { class: "btn link", text: t("q_clear"), attrs: { type: "button" }, on: { click: function () { selected = {}; render(); } } }));
    return el("div", { class: "bulkbar" }, list);
  }

  function render() {
    Sahra.clear(app);
    Sahra.title(t("q_title"));
    if (!me) { app.appendChild(Sahra.problem({ kicker: t("nt_kicker_signin"), title: t("nt_staff_t"), text: t("d_sign_in"),
      actions: [[t("sign_in"), "/signin", true], [t("nt_home"), "/"]], hint: t("nt_guest_hint") })); return; }
    app.classList.add("staff");
    app.appendChild(SahraStaff.nav("queue", me.staff.role));
    app.appendChild(el("header", { class: "staff-head" }, el("div", null,
      el("p", { class: "label-line", text: me.party.name }), el("h1", { text: t("q_title") }))));
    app.appendChild(el("div", { class: "tabs", attrs: { role: "group" } }, TABS.map(function (x) {
      return el("button", { text: t(x[1]), attrs: { type: "button", "aria-pressed": tab === x[0] ? "true" : "false" },
        on: { click: function () { if (tab !== x[0]) { tab = x[0]; load(false); } } } });
    })));
    // Guests who paid the organiser in cash (brainstorm idea 9), on any tab.
    var cashChip = el("button", { class: "chip", text: t("q_cash_only"), attrs: { type: "button", "aria-pressed": cashOnly ? "true" : "false" },
      on: { click: function () { cashOnly = !cashOnly; load(false); } } });
    app.appendChild(el("div", { class: "chips q-filters" }, cashChip));
    if (bulkNote) app.appendChild(el("p", { class: "notice " + bulkNote.cls, text: bulkNote.text }));
    if (failed) { app.appendChild(el("p", { class: "notice no", text: failed })); return; }
    if (!rows) { app.appendChild(el("p", { class: "muted", text: t("loading") })); return; }
    if (!rows.length) app.appendChild(el("p", { class: "empty", text: cashOnly ? t("q_none_cash") : t("q_none") }));
    else {
      var selectable = rows.filter(function (r) { return tab === "pending" ? !notes[r.id] || notes[r.id].cls === "no" : tab === "approved" && !r.released_at; });
      if (selectable.length > 1) {
        app.appendChild(el("button", { class: "btn link", text: t("q_select_all"), attrs: { type: "button" },
          on: { click: function () { selectable.slice(0, MAX).forEach(function (r) { selected[r.id] = true; }); render(); } } }));
      }
      app.appendChild(el("div", { class: "reqs" }, grouped(rows).map(card)));
    }
    if (next) app.appendChild(el("button", { class: "btn", text: t("q_more"), attrs: { type: "button", disabled: busy }, on: { click: function () { load(true); } } }));
    app.appendChild(el("div", { class: "page-tools" },
      el("div", { class: "stack buttons" }, el("button", { class: "btn", text: t("q_export"), attrs: { type: "button" }, on: { click: exportCsv } })),
      tab === "pending" ? staleTool() : null));
    var bar = bulkbar();
    if (bar) app.appendChild(bar);
  }

  // "Reject every waiting request older than N hours" (requests are only cleaned up by hand):
  // one bounded batch per call, repeated while some remain. The reason is shown to the guests.
  var stale = { open: false, note: null };
  function staleTool() {
    var box = el("p", { class: "say", attrs: { role: "status" } });
    if (stale.note) SahraStaff.say(box, stale.note[0], stale.note[1]);
    var f = el("form", { attrs: { novalidate: true } },
      el("div", { class: "s-two" },
        SahraStaff.field(t("q_stale_hours"), SahraStaff.input("hours", "number", { min: 1, max: 720, value: 72, inputmode: "numeric" }), t("q_stale_hours_h")),
        SahraStaff.field(t("q_stale_reason"), SahraStaff.input("reason", "text", { maxlength: 300, value: t("q_stale_reason_default"), dir: "auto" }), t("q_stale_reason_h"))),
      el("div", { class: "s-save" }, el("button", { class: "btn no small-btn", text: t("q_stale_go"), attrs: { type: "submit", disabled: busy } }), box));
    f.addEventListener("submit", async function (e) {
      e.preventDefault();
      var hours = Number(f.elements.hours.value), reason = f.elements.reason.value.trim();
      if (!(hours >= 1 && hours <= 720) || !reason) { SahraStaff.say(box, "no", t("q_stale_needed")); return; }
      if (!(await Sahra.confirm(t("q_stale_confirm", { h: hours }), { danger: true }))) return;
      busy = true;
      var total = 0, r;
      for (var round = 0; round < 100; round++) {
        r = await post("/api/tickets/reject-stale", { hours: hours, reason: reason });
        if (!r.ok) break;
        total += r.body.rejected;
        if (!r.body.remaining || !r.body.rejected) break;
      }
      busy = false;
      stale.note = r.ok ? ["yes", SahraStaff.tn("q_stale_done", total)] : ["no", SahraStaff.why(r) + (total ? " " + SahraStaff.tn("q_stale_done", total) : "")];
      stale.open = true;
      await load(false);
    });
    var d = el("details", { class: "card q-stale" }, el("summary", { text: t("q_stale") }), el("p", { class: "small muted", text: t("q_stale_p") }), f);
    d.open = stale.open;
    d.addEventListener("toggle", function () { stale.open = d.open; });
    return d;
  }

  async function load(append) {
    if (!append) { rows = null; next = null; selected = {}; notes = {}; bulkNote = null; failed = null; render(); }
    var r = await Sahra.api.get("/api/tickets?status=" + tab + (cashOnly ? "&payment=cash" : "") + (append && next ? "&after=" + encodeURIComponent(next) : ""));
    if (!r.ok) { failed = Sahra.errorText(r); render(); return; }
    rows = (append && rows ? rows : []).concat(r.body.tickets);
    next = r.body.next;
    render();
  }

  // --- guest list download (the same CSV as the queue tools page) ----------

  function csvCell(v) {
    var s = v === null || v === undefined ? "" : String(v);
    // Spreadsheet formula injection: cells starting with = + - @ are prefixed.
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function iso(ms) { return ms ? new Date(ms).toISOString() : ""; }
  async function exportCsv() {
    var all = [], after = "";
    for (var page = 0; page < 50; page++) {
      var r = await Sahra.api.get("/api/tickets/export?limit=500" + (after ? "&after=" + encodeURIComponent(after) : ""));
      if (!r.ok) { await Sahra.notify(Sahra.errorText(r)); return; }
      all = all.concat(r.body.tickets);
      if (!r.body.next) break;
      after = r.body.next;
    }
    var keys = {};
    all.forEach(function (x) { Object.keys(x.answers || {}).forEach(function (k) { keys[k] = true; }); });
    var qs = Object.keys(keys);
    var head = ["ticket", "status", "name", "email", "instagram", "people", "type", "price per person (EGP)", "total (EGP)", "paid by", "requested", "approved", "approved by", "rejected", "rejected by",
      "reason", "QR sent", "QR sent by", "scanned", "scanned by"].concat(qs);
    var lines = [head.map(csvCell).join(",")];
    all.forEach(function (x) {
      lines.push([x.id, x.status, x.guest_name, x.guest_email, x.instagram ? "@" + x.instagram : "", x.people, x.type_name, x.price, x.total_price, x.payment === "cash" ? "cash" : "", iso(x.created_at), iso(x.approved_at), x.approved_by,
        iso(x.rejected_at), x.rejected_by, x.reject_reason, iso(x.released_at), x.released_by, iso(x.used_at), x.scanned_by]
        .concat(qs.map(function (q) { return (x.answers || {})[q]; })).map(csvCell).join(","));
    });
    var a = el("a", { attrs: { href: URL.createObjectURL(new Blob([lines.join("\r\n")], { type: "text/csv" })), download: "guests.csv" } });
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  (async function () {
    me = await Sahra.api.me();
    if (me && me.staff.role === "door") { location.href = "/scan.html"; return; }
    Sahra.boot({ render: render, me: me });
    if (me) load(false);
  })();
})();
