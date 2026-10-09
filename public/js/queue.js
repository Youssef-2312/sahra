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
  var me = null, tab = "pending", rows = null, next = null, failed = null;
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
  async function showShot(id, box, button) {
    button.disabled = true;
    var r;
    try { r = await fetch("/api/tickets/" + encodeURIComponent(id) + "/screenshot", { credentials: "same-origin" }); } catch (e) { r = null; }
    if (!r || !r.ok) {
      button.remove();
      box.appendChild(el("p", { class: "small muted", text: r && r.status === 410 ? t("q_shot_gone") : t("error_generic") }));
      return;
    }
    var reader = new FileReader();
    reader.onload = function () { button.remove(); box.appendChild(el("img", { attrs: { src: reader.result, alt: t("q_show_shot") } })); };
    reader.readAsDataURL(await r.blob());
  }

  // --- cards ---------------------------------------------------------------

  function people(n) { return n === 1 ? t("one_person") : t("q_people", { n: n }); }

  function rejectForm(row, actions) {
    Sahra.clear(actions);
    var input = el("input", { attrs: { type: "text", maxlength: 300, dir: "auto", "aria-label": t("q_reject_reason"), placeholder: t("q_reject_reason") } });
    actions.appendChild(el("div", { class: "main" }, input));
    actions.appendChild(el("button", { class: "btn", text: t("q_cancel"), attrs: { type: "button" }, on: { click: render } }));
    actions.appendChild(el("button", { class: "btn no", text: t("q_reject_confirm"), attrs: { type: "button" },
      on: { click: function () { run([row.id], function (ids) { return reject(ids, input.value.trim()); }); } } }));
    input.focus();
  }

  function card(row) {
    var note = notes[row.id];
    var finished = note && note.cls !== "no" && (note.state === "sent" || note.state === "rejected" || (tab === "pending" && note.state === "approved" && note.cls === "yes"));
    var canSelect = !finished && (tab === "pending" || (tab === "approved" && !row.released_at));
    var box = canSelect ? el("input", { attrs: { type: "checkbox", "aria-label": t("q_select") },
      on: { change: function (e) { if (e.target.checked) selected[row.id] = true; else delete selected[row.id]; render(); } } }) : null;
    if (box) box.checked = !!selected[row.id];

    var shot = el("div", { class: "shot" });
    if (row.has_screenshot) {
      var sb = el("button", { class: "btn link", text: t("q_show_shot"), attrs: { type: "button" } });
      sb.addEventListener("click", function () { showShot(row.id, shot, sb); });
      shot.appendChild(sb);
    } else if (row.price) {
      shot.appendChild(el("p", { class: "small muted", text: t("q_no_shot") }));
    }

    var answers = Object.keys(row.answers || {});
    var details = el("details", null, el("summary", { text: t("q_details") }),
      el("ul", { class: "facts" },
        row.guest_email ? el("li", null, el("span", { class: "muted", text: t("q_email") + ": " }), el("span", { text: row.guest_email, attrs: { dir: "ltr" } })) : null,
        el("li", { class: "muted", text: t("q_requested", { when: Sahra.rel(row.created_at) }) }),
        answers.map(function (k) {
          return el("li", null, el("span", { class: "muted", text: k + ": ", attrs: { dir: "auto" } }), el("span", { class: "pre", text: String(row.answers[k]), attrs: { dir: "auto" } }));
        })));

    var actions = el("div", { class: "actions" });
    if (!finished && !busy) {
      if (tab === "pending") {
        actions.appendChild(el("button", { class: "btn primary main", text: t("q_approve_send"), attrs: { type: "button" },
          on: { click: function () { run([row.id], function (ids) { return approve(ids, true); }); } } }));
        actions.appendChild(el("button", { class: "btn", text: t("q_approve"), attrs: { type: "button" },
          on: { click: function () { run([row.id], function (ids) { return approve(ids, false); }); } } }));
        actions.appendChild(el("button", { class: "btn no", text: t("q_reject"), attrs: { type: "button" }, on: { click: function () { rejectForm(row, actions); } } }));
      } else if (tab === "approved" && !row.released_at) {
        actions.appendChild(el("button", { class: "btn primary main", text: t("q_send"), attrs: { type: "button" },
          on: { click: function () { run([row.id], release); } } }));
      }
    }
    // After "Approve and send" failed to send: offer Send QR on the same card.
    if (tab === "pending" && note && note.cls === "maybe" && !busy) {
      actions.appendChild(el("button", { class: "btn primary main", text: t("q_send"), attrs: { type: "button" },
        on: { click: function () { run([row.id], release); } } }));
    }

    var status = tab === "approved" ? el("span", { class: "pill " + (row.released_at ? "yes" : "maybe"), text: row.released_at ? t("q_sent") : t("q_approved") })
      : tab === "rejected" ? el("span", { class: "pill no", text: t("q_rejected") }) : null;

    return el("article", { class: "req" + (finished ? " done" : "") },
      el("div", { class: "head" },
        el("label", { class: "check" }, box,
          el("span", null, el("span", { class: "who", text: row.guest_name || "-", attrs: { dir: "auto" } }), el("br"),
            el("span", { class: "small muted", text: [row.type_name, people(row.people)].filter(Boolean).join(" · "), attrs: { dir: "auto" } }))),
        status),
      row.price ? el("p", { class: "price", text: t("q_expected", { amount: Sahra.amount(row.price * row.people) }) }) : null,
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
        on: { click: function () {
          var reason = window.prompt(t("q_reject_reason"), "");
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
    if (!me) { app.appendChild(el("p", { class: "notice maybe", text: t("d_sign_in") })); return; }
    app.appendChild(el("a", { class: "btn link", text: t("q_back"), attrs: { href: "/dashboard.html" } }));
    app.appendChild(el("div", { class: "row" }, el("h1", { text: t("q_title") }), el("span", { class: "small muted", text: me.party.name, attrs: { dir: "auto" } })));
    app.appendChild(el("div", { class: "tabs", attrs: { role: "group" } }, TABS.map(function (x) {
      return el("button", { text: t(x[1]), attrs: { type: "button", "aria-pressed": tab === x[0] ? "true" : "false" },
        on: { click: function () { if (tab !== x[0]) { tab = x[0]; load(false); } } } });
    })));
    if (bulkNote) app.appendChild(el("p", { class: "notice " + bulkNote.cls, text: bulkNote.text }));
    if (failed) { app.appendChild(el("p", { class: "notice no", text: failed })); return; }
    if (!rows) { app.appendChild(el("p", { class: "muted", text: t("loading") })); return; }
    if (!rows.length) app.appendChild(el("p", { class: "empty", text: t("q_none") }));
    else {
      var selectable = rows.filter(function (r) { return tab === "pending" ? !notes[r.id] || notes[r.id].cls === "no" : tab === "approved" && !r.released_at; });
      if (selectable.length > 1) {
        app.appendChild(el("button", { class: "btn link", text: t("q_select_all"), attrs: { type: "button" },
          on: { click: function () { selectable.slice(0, MAX).forEach(function (r) { selected[r.id] = true; }); render(); } } }));
      }
      app.appendChild(el("div", { class: "reqs" }, rows.map(card)));
    }
    if (next) app.appendChild(el("button", { class: "btn", text: t("q_more"), attrs: { type: "button", disabled: busy }, on: { click: function () { load(true); } } }));
    app.appendChild(el("div", { class: "stack buttons page-tools" },
      el("button", { class: "btn", text: t("q_export"), attrs: { type: "button" }, on: { click: exportCsv } }),
      el("a", { class: "btn", text: t("q_tools"), attrs: { href: "/queue-tools.html" } })));
    var bar = bulkbar();
    if (bar) app.appendChild(bar);
  }

  async function load(append) {
    if (!append) { rows = null; next = null; selected = {}; notes = {}; bulkNote = null; failed = null; render(); }
    var r = await Sahra.api.get("/api/tickets?status=" + tab + (append && next ? "&after=" + encodeURIComponent(next) : ""));
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
      if (!r.ok) { window.alert(Sahra.errorText(r)); return; }
      all = all.concat(r.body.tickets);
      if (!r.body.next) break;
      after = r.body.next;
    }
    var keys = {};
    all.forEach(function (x) { Object.keys(x.answers || {}).forEach(function (k) { keys[k] = true; }); });
    var qs = Object.keys(keys);
    var head = ["ticket", "status", "name", "email", "people", "type", "price per person (EGP)", "total (EGP)", "requested", "approved", "approved by", "rejected", "rejected by",
      "reason", "QR sent", "QR sent by", "scanned", "scanned by"].concat(qs);
    var lines = [head.map(csvCell).join(",")];
    all.forEach(function (x) {
      lines.push([x.id, x.status, x.guest_name, x.guest_email, x.people, x.type_name, x.price, x.total_price, iso(x.created_at), iso(x.approved_at), x.approved_by,
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
