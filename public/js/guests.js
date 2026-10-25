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
  var actionBusy = {};
  var notes = {};      // ticket id -> [cls, text, link?]
  var searchSeq = 0, nextFound = null, loadingMore = false, pageIndex = 0, pageCursors = [null], filters = { status:"approved" };
  var initialFilters = new URLSearchParams(location.search);
  ["status","type","delivery","entry","booking","payment","date_from","date_to"].forEach(function(k){if(initialFilters.has(k))filters[k]=initialFilters.get(k);});
  var guestView = initialFilters.has("q") || filters.status !== "approved" ? "all" : "approved";
  if (guestView === "all" && !initialFilters.has("status")) filters.status = "all";
  var expandedGuests = {};
  var open = {};       // ticket id -> which tool is open ("transfer")
  var drafts = { issue: null, announce: null };

  function opFor(key) { return ops[key] || (ops[key] = crypto.randomUUID()); }

  function statusOf(x) {
    if (x.used_at) return ["yes", t("g_st_inside")];
    if (x.status === "approved" && x.hold_at) return ["maybe", t("g_st_hold")];
    if (x.status === "approved") return x.released_at ? ["yes", t("g_st_sent")] : ["maybe", t("g_st_approved")];
    if (x.status === "pending") return ["maybe", t("g_st_pending")];
    if (x.status === "rejected") return ["no", t("g_st_rejected")];
    if (x.status === "cancelled") return ["no", t(x.approved_at == null ? "bk_deleted" : "bk_position_cancelled")];
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

  async function search(q, direction) {
    var move = direction === 1 || direction === -1 ? direction : 0;
    if (move && (loadingMore || (move < 0 && !pageIndex) || (move > 0 && !nextFound))) return;
    var target = move ? pageIndex + move : 0;
    if (!move) pageCursors = [null];
    if (move > 0) pageCursors[target] = nextFound;
    query = q;
    var seq = ++searchSeq;
    loadingMore = !!move;
    if (!move) { found = "loading"; nextFound = null; pageIndex = 0; }
    redrawFind();
    var params = SahraBooking.params(Object.assign({}, filters, {q:q.trim(),status:filters.status || "all",limit:20}));
    if (pageCursors[target]) params.set("after", pageCursors[target]);
    var r = await Sahra.api.get("/api/tickets?" + params.toString());
    if (seq !== searchSeq) return;
    loadingMore = false;
    found = r.ok ? r.body.tickets : { error:r }; pageIndex = target;
    nextFound = r.ok ? r.body.next : null;
    redrawFind();
    if (move && r.ok) {
      var first = findNode.querySelector('.bk-pager-top') || findNode.querySelector('.g-row');
      if (first) { first.scrollIntoView({block:"start"}); first.focus({preventScroll:true}); }
    }
  }

  async function run(x, action, body, confirmText, safe) {
    var key = action + ":" + x.id;
    if (actionBusy[key]) return;
    if (confirmText && !(await Sahra.confirm(confirmText, { danger: !safe, ok:action === "unreject" ? t("ur_action") : undefined }))) return;
    actionBusy[key] = true;
    redrawFind();
    try {
      var path = action === "release" ? "/api/tickets/release" : "/api/tickets/" + encodeURIComponent(x.id) + "/" + action;
      var payload = action === "release" ? {ids:[x.id]} : action === "resend" ? {} : Object.assign({ op: opFor(key) }, body || {});
      var r = await S.act(path, payload);
      if (r.status !== 503) delete ops[key];
      var link = r.body && r.body.link ? location.origin + r.body.link : null;
      if (action === "release") {
        var result = r.body && r.body.results && r.body.results[x.id];
        notes[x.id] = r.ok && (result === "done" || result === "already")
          ? ["yes", t(x.guest_email ? "g_qr_released" : "g_qr_released_no_email")]
          : ["no", r.ok ? t("g_qr_release_refused") : S.why(r)];
      } else if (action === "resend") {
        notes[x.id] = r.ok ? ["yes", r.body.status === "queued" ? t("g_resent") : t("g_resent_already"), link]
          : r.body && r.body.error === "no_email" ? ["maybe", t("g_no_email"), link] : ["no", S.why(r)];
      } else if (!r.ok) {
        var code = r.body && r.body.error;
        notes[x.id] = ["no", code === "not_allowed" ? t("g_not_allowed_" + action)
          : (action === "restore" || action === "unreject") && SahraText.en["g_restore_" + code] ? t("g_restore_" + code) : S.why(r)];
      } else {
        notes[x.id] = ["yes", t("g_done_" + action), link];
        delete open[x.id];
      }
      // Always read the authoritative ticket after a successful action, including
      // a bulk release refusal (the guest may have been cancelled in another tab).
      if (r.ok) {
        if (query || Array.isArray(found)) await search(query);
        await loadStats();
        if (action !== "resend") try { localStorage.setItem("sahra_ticket_change", String(Date.now())); } catch (_) {}
      }
    } finally { delete actionBusy[key]; redrawFind(); }
  }

  function guestRow(x) {
    var st = statusOf(x);
    var meta = [x.type_name, x.people === 1 ? t("s_type_one") : t("s_type_exactly", { n: x.people })].filter(Boolean).join(" · ");
    var live = x.status === "pending" || x.status === "approved";
    var actions = el("div", { class: "g-actions" },
      x.status === "approved" && !x.released_at && !x.hold_at && !x.used_at ? el("button", {class:"btn primary small-btn",text:t("g_send_qr"),attrs:{type:"button",disabled:!!actionBusy["release:"+x.id]},on:{click:function(){run(x,"release");}}}) : null,
      live && x.released_at ? el("button", { class: "btn small-btn", text: t("g_resend"), attrs: { type: "button",disabled:!!actionBusy["resend:"+x.id] }, on: { click: function () { run(x, "resend"); } } }) : null,
      x.status === "approved" && !x.used_at ? el("button", { class: "btn small-btn", text: t("g_reissue"), attrs: { type: "button" }, on: { click: function () { run(x, "reissue", null, t("g_reissue_confirm")); } } }) : null,
      live && !x.used_at ? el("button", { class: "btn small-btn", text: t("g_change_email"), attrs: { type: "button", "aria-expanded": open[x.id] === "email" ? "true" : "false" }, on: { click: function () { open[x.id] = open[x.id] === "email" ? null : "email"; redrawFind(); } } }) : null,
      live && !x.used_at ? el("button", { class: "btn small-btn", text: t("g_transfer"), attrs: { type: "button", "aria-expanded": open[x.id] === "transfer" ? "true" : "false" }, on: { click: function () { open[x.id] = open[x.id] === "transfer" ? null : "transfer"; redrawFind(); } } }) : null,
      // A cancelled ticket can be brought back (owner request), with a new QR code.
      x.status === "cancelled" && !x.used_at ? el("button", { class: "btn small-btn", text: t(x.approved_at == null ? "bk_restore_request" : "g_restore"), attrs: { type: "button" }, on: { click: function () { run(x, "restore", null, t(x.approved_at == null ? "bk_restore_request_confirm" : "g_restore_confirm", { name: x.guest_name || Sahra.ref(x.id) }), true); } } }) : null);
    if(x.status === "rejected" && !x.used_at && !x.hold_at) actions.appendChild(el("button",{class:"btn small-btn",text:t("ur_action"),attrs:{type:"button",disabled:!!actionBusy["unreject:"+x.id]},on:{click:function(){run(x,"unreject",null,t("ur_confirm",{name:x.guest_name || Sahra.ref(x.id)}),true);}}}));
    var note = notes[x.id];
    var li = el("li", { class: "g-row g-guest-card", attrs:{"data-ticket":x.id,tabindex:-1} },
      el("div", { class: "g-who" },
        el("div", { class: "g-name-line" }, el("strong", { text: x.guest_name || t("g_no_name"), attrs: { dir: "auto" } }), el("span", { class: "pill " + st[0], text: st[1] })),
        el("span", { class: "muted small", text: meta, attrs: { dir: "auto" } }),
        el("span", { class: "faint small mono", text: Sahra.ref(x.id), attrs: { dir: "ltr" } })),
      null);
    var booking = SahraBooking.card(x, function () { if (query || Array.isArray(found)) search(query); loadStats(); });
    booking.classList.add("g-review");
    booking.querySelector("summary strong").textContent = t("qc_guest_details");
    var extra=el("div",{class:"g-review-extra"},x.guest_email?el("p",{class:"small muted",text:x.guest_email,attrs:{dir:"ltr"}}):null,actions);
    booking.insertBefore(extra,booking.querySelector(".bk-body"));
    booking.open=!!expandedGuests[x.id] || !!open[x.id];
    booking.addEventListener("toggle",function(){if(booking.isConnected)expandedGuests[x.id]=booking.open;});
    if (!live) li.appendChild(el("p", { class: "small muted", text: t("bk_inactive") }));
    li.appendChild(booking);
    var photos = Object.keys(x.answers || {}).filter(function (id) { return typeof x.answers[id] === "string" && /^photo:f[1-4]:[1-9][0-9]*$/.test(x.answers[id]); });
    if (photos.length) extra.appendChild(el("ul", { class: "facts" }, photos.map(function (id) {
      return el("li", null, el("span", { text: id + ": ", attrs: { dir: "auto" } }),
        el("a", { class: "btn small-btn", text: t("view_answer_photo"), attrs: { href: "/api/tickets/" + encodeURIComponent(x.id) + "/answers/" + encodeURIComponent(id) + "/photo", target: "_blank", rel: "noopener" } }));
    })));
    if (open[x.id] === "transfer") extra.appendChild(transferForm(x));
    if (open[x.id] === "email") extra.appendChild(emailForm(x));
    if (note) {
      var box = S.sayBox();
      S.say(box, note[0], note[1]);
      li.appendChild(el("div", { class: "g-note" }, box, note[2] ? el("div", { class: "g-link" }, el("code", { text: note[2], attrs: { dir: "ltr" } }), S.copyButton(note[2], t("g_copy_link"))) : null));
    }
    return li;
  }

  // Change the email only (brainstorm idea 15): a transfer with the same name. The old link and QR stop
  // working, the new link goes to the new address, and the old address gets a notice (from the server).
  function emailForm(x) {
    var f = el("form", { class: "s-editor g-transfer", attrs: { novalidate: true } },
      el("p", { class: "small muted", text: t("g_change_email_h") }),
      S.field(t("g_new_email"), S.input("email", "email", { required: true, placeholder: x.guest_email || "", dir: "ltr" })),
      el("div", { class: "s-save" }, el("button", { class: "btn primary small-btn", text: t("g_change_email_go"), attrs: { type: "submit" } })));
    f.addEventListener("submit", function (e) {
      e.preventDefault();
      var email = f.elements.email.value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { f.elements.email.focus(); return; }
      run(x, "transfer", { name: x.guest_name || t("g_no_name"), email: email }, t("g_change_email_confirm", { email: email }));
    });
    return f;
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
    var f = SahraBooking.filters(Object.assign({}, filters, {q:query}), types, function (v) {
      filters = v; guestView=v.status === "approved" ? "approved" : "all"; search(v.q || "");
    }, true, guestView === "approved" ? "approved" : null);
    var tabs = el("div", {class:"tabs",attrs:{"aria-label":t("g_title")}}, [["approved","bf_active_guests"],["all","bf_all_records"]].map(function(x){
      return el("button",{text:t(x[1]),attrs:{type:"button","aria-pressed":guestView===x[0]?"true":"false"},on:{click:function(){guestView=x[0];filters.status=x[0]==="approved"?"approved":"all";search(query);}}});
    }));
    var body;
    if (found === null) body = el("p", { class: "small muted", text: t("g_search_h") });
    else if (found === "loading") body = el("p", { class: "muted", text: t("loading") });
    else if (found.error) body = el("p", { class: "notice no", text: S.why(found.error) });
    else if (!found.length) body = el("div", null, el("p", { class: "s-empty muted", text: t("g_none", { q: query }) }));
    else {
      body = el("div", { class: "g-results" });
      [["bk_entry_guests", function (x) { return x.status === "approved"; }],
       ["bk_waiting_requests", function (x) { return x.status === "pending"; }],
       ["bk_history", function (x) { return x.status !== "approved" && x.status !== "pending"; }]].forEach(function (section) {
        var list = found.filter(section[1]);
        if (list.length) body.appendChild(el("section", null, el("h3", { class: "s-sub", text: t(section[0]) }), el("ul", { class: "g-list" }, list.map(guestRow))));
      });
    }
    function pageControls(position) {
      return SahraBooking.pager(found.length, nextFound, loadingMore, function (direction) { search(query, direction); }, function () {
        var input = findNode.querySelector('input[name=q]'); input.scrollIntoView({block:"center"}); input.focus({preventScroll:true});
      }, pageIndex, position);
    }
    if (Array.isArray(found)) body.appendChild(pageControls("bottom"));
    body.setAttribute("role", "status");
    body.setAttribute("aria-live", "polite");
    findNode = S.section("find", t("g_find"), null, tabs, f, Array.isArray(found) ? pageControls("top") : null, body, SahraBooking.guide());
    findNode.dataset.guestView=guestView;
    return findNode;
  }
  function redrawFind() {
    if (!findNode || !findNode.parentNode) return;
    var hadFocus = document.activeElement && findNode.contains(document.activeElement) && document.activeElement.name === "q";
    var old = findNode;
    old.parentNode.replaceChild(findCard(), old);
    if(Array.isArray(found)) Sahra.motionCards(findNode,".g-guest-card","guests:"+pageIndex+":"+found.map(function(x){return x.id;}).join(","));
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
      S.field(t("g_payment"), S.select("payment", [["cash", t("g_pay_cash")], ["free", t("g_pay_free")]], "cash"), t("g_payment_h")),
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
        cash: f.elements.payment.value === "cash", complimentary: f.elements.payment.value === "free", release: f.elements.release.checked });
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

  // ------------------------------------------------------------- cash guests from a CSV file
  // Brainstorm ideas 9 and 17: the organiser's own file (name, email, ticket type, people),
  // read here; a preview flags problems; nothing is created until "Confirm". Rows go to
  // the server 5 at a time (POST /api/tickets/import), which applies every rule again.

  var CHUNK = 5;
  var imp = null;      // { rows, release, op, sent, results, busy }

  /** CSV text to rows of cells (quotes, "" inside quotes, commas or semicolons, CRLF). */
  function parseCsv(text) {
    var first = text.split(/\r?\n/)[0] || "";
    var sep = (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ";" : ",";
    var out = [], row = [], cell = "", q = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (q) {
        if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (ch === '"') q = false;
        else cell += ch;
      } else if (ch === '"') q = true;
      else if (ch === sep) { row.push(cell); cell = ""; }
      else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && text[i + 1] === "\n") i++;
        row.push(cell); cell = "";
        if (row.some(function (c) { return c.trim() !== ""; })) out.push(row);
        row = [];
      } else cell += ch;
    }
    row.push(cell);
    if (row.some(function (c) { return c.trim() !== ""; })) out.push(row);
    return out;
  }

  function prepare(text) {
    var cells = parseCsv(text.replace(/^\ufeff/, ""));
    if (!cells.length) return { error: t("g_imp_empty") };
    var head = cells[0].map(function (h) { return h.trim().toLowerCase(); });
    var col = function (names) { for (var i = 0; i < head.length; i++) if (names.indexOf(head[i]) >= 0) return i; return -1; };
    var ci = { name: col(["name", "guest name", "الاسم"]), email: col(["email", "e-mail", "البريد", "البريد الإلكتروني"]),
      type: col(["ticket type", "type", "ticket", "نوع التذكرة"]), people: col(["people", "guests", "الأشخاص"]) };
    var body = cells.slice(1);
    if (ci.name < 0) { ci = { name: 0, email: 1, type: 2, people: 3 }; body = cells; }
    var open = types.filter(function (x) { return !x.archived; });
    var max = party && party.max_tickets_per_email, left = stats ? stats.places_left : Infinity, used = 0, perEmail = {};
    var rows = body.slice(0, 2000).map(function (c, i) {
      var get = function (k) { return ci[k] >= 0 && c[ci[k]] !== undefined ? String(c[ci[k]]).trim() : ""; };
      var r = { line: i + 1, name: get("name").replace(/\s+/g, " "), email: get("email").toLowerCase(), people: Number(get("people") || 1), typeName: get("type"), type_id: null, problems: [] };
      if (!r.name) r.problems.push(t("g_imp_p_name"));
      else if (r.name.length > 80) r.problems.push(t("g_imp_p_long"));
      if (r.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email)) r.problems.push(t("g_imp_p_email"));
      if (!Number.isInteger(r.people) || r.people < 1 || r.people > 50) { r.problems.push(t("g_imp_p_people")); r.people = 1; }
      if (open.length) {
        var match = r.typeName ? open.filter(function (x) { return x.name.toLowerCase() === r.typeName.toLowerCase(); })[0] : (open.length === 1 ? open[0] : null);
        if (match) r.type_id = match.id; else r.problems.push(r.typeName ? t("g_imp_p_type", { type: r.typeName }) : t("g_imp_p_type_needed"));
      }
      if (r.email) {
        perEmail[r.email] = (perEmail[r.email] || 0) + 1;
        if (perEmail[r.email] > 1) r.problems.push(t("g_imp_p_dup"));
        else if (max && perEmail[r.email] > max) r.problems.push(t("g_imp_p_max", { n: max }));
      }
      if (!r.problems.length) { used += r.people; if (used > left) r.problems.push(t("g_imp_p_full")); }
      return r;
    });
    if (body.length > 2000) return { error: t("g_imp_too_many") };
    return { rows: rows };
  }

  function importCard() {
    var box = S.sayBox();
    var template = "name,email,ticket type,people\r\nMona Salem,mona@example.com," + (types[0] ? types[0].name : "") + ",1\r\n";
    var dl = el("a", { class: "btn small-btn", text: t("g_imp_template"), attrs: { download: "sahra-guests.csv",
      href: URL.createObjectURL(new Blob(["\ufeff" + template], { type: "text/csv" })) } });
    var file = el("input", { attrs: { type: "file", accept: ".csv,text/csv", id: "imp-file" }, class: "sr-file" });
    var pick = el("label", { class: "btn small-btn", text: t("g_imp_choose"), attrs: { for: "imp-file" } });
    file.addEventListener("change", function () {
      var f = file.files && file.files[0];
      if (!f) return;
      if (f.size > 512 * 1024) { S.say(box, "no", t("g_imp_too_big")); return; }
      var reader = new FileReader();
      reader.onload = function () {
        var p = prepare(String(reader.result || ""));
        if (p.error) { S.say(box, "no", p.error); return; }
        imp = { rows: p.rows, release: true, op: crypto.randomUUID(), sent: 0, results: {}, busy: false, file: f.name };
        redrawImport();
      };
      reader.readAsText(f);
    });
    var body;
    if (!imp) {
      body = [el("p", { class: "small muted", text: t("g_imp_how") }), el("div", { class: "g-actions" }, dl, file, pick), box];
    } else {
      var ok = imp.rows.filter(function (r) { return !r.problems.length; });
      var bad = imp.rows.length - ok.length;
      var done = imp.sent >= ok.length && imp.sent > 0;
      var counts = {};
      Object.keys(imp.results).forEach(function (k) { var st = imp.results[k]; counts[st] = (counts[st] || 0) + 1; });
      var list = el("ul", { class: "s-list imp-list" }, imp.rows.slice(0, 300).map(function (r) {
        var res = imp.results[r.line];
        var pill = r.problems.length ? el("span", { class: "pill no", text: t("g_imp_skip") })
          : res ? el("span", { class: "pill " + (res === "created" || res === "already" ? "yes" : "no"), text: t("g_imp_r_" + res) || res })
            : el("span", { class: "pill", text: t("g_imp_ready") });
        return el("li", { class: r.problems.length ? "off" : null },
          el("div", { class: "s-type-text" }, el("strong", { text: (r.name || "-"), attrs: { dir: "auto" } }),
            el("span", { class: "muted small", text: [r.email, r.typeName, S.tn("g_people_n", r.people)].filter(Boolean).join(" \u00b7 "), attrs: { dir: "auto" } }),
            r.problems.length ? el("span", { class: "small say no", text: r.problems.join(" ") }) : null),
          pill);
      }));
      var summary = el("p", { class: "imp-summary" }, el("strong", { text: imp.release ? t("g_imp_sum_send", { n: ok.length }) : t("g_imp_sum_add", { n: ok.length }) }),
        bad ? el("span", { class: "muted small imp-skipped", text: S.tn("g_imp_skipped", bad) }) : null);
      var choice = el("fieldset", { class: "s-modes" }, [["now", true], ["later", false]].map(function (o) {
        var r = el("input", { attrs: { type: "radio", name: "imp-release", value: o[0], disabled: imp.busy || imp.sent > 0 } });
        r.checked = imp.release === o[1];
        r.addEventListener("change", function () { imp.release = o[1]; redrawImport(); });
        return el("label", { class: "choice" }, r, el("span", { class: "grow" }, el("strong", { text: t("g_imp_" + o[0]) }), el("span", { class: "muted small", text: t("g_imp_" + o[0] + "_h") })));
      }));
      var go = el("button", { class: "btn primary small-btn", text: imp.busy ? t("g_imp_sending", { n: imp.sent, of: ok.length }) : t("g_imp_confirm"),
        attrs: { type: "button", disabled: imp.busy || !ok.length || done } });
      go.addEventListener("click", function () { runImport(ok); });
      var again = el("button", { class: "btn link", text: t("g_imp_other"), attrs: { type: "button", disabled: imp.busy } });
      again.addEventListener("click", function () { imp = null; redrawImport(); });
      body = [el("p", { class: "small muted", text: t("g_imp_file", { name: imp.file, n: imp.rows.length }) }), list,
        imp.rows.length > 300 ? el("p", { class: "small muted", text: t("g_imp_more", { n: imp.rows.length - 300 }) }) : null,
        done ? el("p", { class: "notice yes", text: t("g_imp_done", { created: (counts.created || 0) + (counts.already || 0), refused: ok.length - (counts.created || 0) - (counts.already || 0) }) }) : [choice, summary],
        imp.error ? el("p", { class: "notice no", text: imp.error }) : null,
        el("div", { class: "s-save" }, done ? null : go, again)];
    }
    importNode = S.section("import", t("g_import"), t("g_import_p"), el("div", null, body));
    return importNode;
  }
  var importNode = null;
  function redrawImport() {
    var old = importNode;
    if (old && old.parentNode) old.parentNode.replaceChild(importCard(), old);
  }

  async function runImport(ok) {
    if (imp.busy) return;
    if (!(await Sahra.confirm(imp.release ? t("g_imp_sum_send", { n: ok.length }) + "?" : t("g_imp_sum_add", { n: ok.length }) + "?"))) return;
    imp.busy = true; imp.error = null; redrawImport();
    while (imp.sent < ok.length) {
      var part = ok.slice(imp.sent, imp.sent + CHUNK);
      var r = await S.act("/api/tickets/import", { op: imp.op, start: imp.sent, release: imp.release,
        rows: part.map(function (x) { return { name: x.name, email: x.email || null, people: x.people, type_id: x.type_id }; }) });
      if (!r.ok) { imp.error = S.why(r); break; }
      r.body.results.forEach(function (x) { imp.results[part[x.row - imp.sent].line] = x.status; });
      if (r.body.results.some(function (x) { return x.status === "limited"; })) { imp.error = t("e_party_limit"); break; }
      imp.sent += part.length;
      redrawImport();
    }
    imp.busy = false;
    redrawImport();
    loadStats();
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

  // Refunds (brainstorm idea 14): due and done, ticked by owners and admins after paying back outside Sahra.
  var refunds = null, refundBusy = {};
  function refundsCard() {
    if (!refunds || (!refunds.refunds.length && !(party && party.cancelled_at))) return null;
    var head = el("div", { class: "g-tiles tiles stats r-totals" },
      el("div", { class: "tile stat" }, el("div", { class: "label", text: t("g_ref_due") }), el("div", { class: "big", text: Sahra.amount(refunds.due_amount) }),
        el("div", { class: "sub muted", text: S.tn("g_ref_n", refunds.due_count) })),
      el("div", { class: "tile stat" }, el("div", { class: "label", text: t("g_ref_done") }), el("div", { class: "big", text: Sahra.amount(refunds.done_amount) }),
        el("div", { class: "sub muted", text: S.tn("g_ref_n", refunds.done_count) })));
    var list = refunds.refunds.length ? el("ul", { class: "s-list" }, refunds.refunds.map(function (x) {
      var done = x.state === "done";
      var b = el("button", { class: "btn small-btn" + (done ? "" : " yes"), text: done ? t("g_ref_undo") : t("g_ref_mark"), attrs: { type: "button", disabled: !!refundBusy[x.ticket_id] } });
      b.addEventListener("click", async function () {
        refundBusy[x.ticket_id] = true; b.disabled = true;
        var r = await S.act("/api/party/refunds/" + encodeURIComponent(x.ticket_id), { state: done ? "due" : "done" });
        delete refundBusy[x.ticket_id];
        if (!r.ok) { await Sahra.notify(S.why(r)); b.disabled = false; return; }
        await loadRefunds();
      });
      return el("li", { class: done ? "off" : null },
        el("div", { class: "s-type-text" }, el("strong", { text: x.guest_name || t("g_no_name"), attrs: { dir: "auto" } }),
          el("span", { class: "muted small", text: [Sahra.amount(x.amount), x.guest_email, Sahra.ref(x.ticket_id)].filter(Boolean).join(" \u00b7 "), attrs: { dir: "auto" } }),
          done ? el("span", { class: "small muted", text: t("g_ref_done_by", { time: Sahra.when(x.updated_at), by: x.by_name || t("g_unknown") }) }) : null),
        b);
    })) : el("p", { class: "s-empty muted", text: t("g_ref_none") });
    return S.section("refunds", t("g_refunds"), t("g_refunds_p"), head, list);
  }
  var refundsNode = null;
  async function loadRefunds() {
    var r = await Sahra.api.get("/api/party/refunds");
    if (r.ok) refunds = r.body;
    var n = refundsCard();
    if (refundsNode && refundsNode.parentNode) { if (n) refundsNode.parentNode.replaceChild(n, refundsNode); refundsNode = n; }
    else S.redraw();
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

  // After a controlled recovery (src/recovery): tickets and team members whose latest
  // change could not be confirmed are on hold (a held ticket does not let anyone in).
  // The owner checks each one and releases it with a reason; shown only when there are any.
  var holds = null, holdBusy = {};
  function holdsCard() {
    if (!holds || (!holds.tickets.length && !holds.staff.length)) return null;
    function row(kind, x) {
      var key = kind + ":" + x.id;
      var reason = S.input("reason", "text", { minlength: 3, maxlength: 500, required: true, placeholder: t("g_hold_reason_ph"), dir: "auto" });
      var b = el("button", { class: "btn small-btn yes", text: t("g_hold_release"), attrs: { type: "submit", disabled: !!holdBusy[key] } });
      var f = el("form", { class: "g-hold" }, S.field(t("g_hold_reason"), reason), b);
      f.addEventListener("submit", async function (e) {
        e.preventDefault();
        if (reason.value.trim().length < 3) { reason.focus(); return; }
        holdBusy[key] = true; b.disabled = true;
        var r = await S.act("/api/recovery/" + kind + "/" + encodeURIComponent(x.id) + "/release-hold", { reason: reason.value.trim() });
        delete holdBusy[key];
        if (!r.ok) { await Sahra.notify(S.why(r)); b.disabled = false; return; }
        await loadHolds();
      });
      var what = kind === "tickets"
        ? [Sahra.ref(x.id), t(x.used_at ? "g_st_inside" : SahraText.en["g_st_" + x.status] ? "g_st_" + x.status : "g_st_hold")].join(" \u00b7 ")
        : t("tm_role_" + x.role);
      return el("li", null,
        el("div", { class: "s-type-text" }, el("strong", { text: (kind === "tickets" ? x.guest_name : x.name) || t("g_no_name"), attrs: { dir: "auto" } }),
          el("span", { class: "muted small", text: what, attrs: { dir: "auto" } }),
          x.hold_reason ? el("span", { class: "small muted", text: x.hold_reason, attrs: { dir: "auto" } }) : null),
        f);
    }
    return S.section("holds", t("g_holds"), t("g_holds_p"),
      el("ul", { class: "s-list" }, holds.tickets.map(function (x) { return row("tickets", x); }).concat(holds.staff.map(function (x) { return row("staff", x); }))));
  }
  var holdsNode = null;
  async function loadHolds() {
    var r = await Sahra.api.get("/api/recovery/holds");
    if (r.ok) holds = r.body;
    S.redraw();
  }

  // ------------------------------------------------------------- page

  var tilesNode = null, scannersNode = null, toolsOpen = {};
  function isToolsView() { return ["guest-tools","issue","import","announce","refunds","manual","scanners","holds"].includes(location.hash.slice(1)); }
  function toolPanel(card) {
    if(!card)return null;
    var id=card.id, title=card.querySelector("h2").textContent;
    var d=el("details",{class:"g-tool-panel"},el("summary",{text:title}),card);
    d.open=!!toolsOpen[id] || location.hash==="#"+id;
    d.addEventListener("toggle",function(){if(d.isConnected)toolsOpen[id]=d.open;});
    return d;
  }
  function showGuestView() {
    var tools=isToolsView(),list=document.getElementById("guest-list-view"),panel=document.getElementById("guest-tools-view"),link=document.getElementById("guest-view-switch");
    if(!list||!panel)return;
    list.hidden=tools;panel.hidden=!tools;
    link.textContent=t(tools?"qc_back_guests":"qc_tools");link.href=tools?"#find":"#guest-tools";
    var target=panel.querySelector(location.hash && location.hash!=="#guest-tools" && location.hash!=="#find" ? '[id="'+location.hash.slice(1).replace(/[^a-z-]/g,"")+'"]':".g-tool-panel");
    if(tools&&target){var disclosure=target.closest("details");if(disclosure)disclosure.open=true;}
  }
  window.addEventListener("hashchange",showGuestView);
  function render(me, app) {
    app.classList.add("guest-workspace");
    var toolbar=el("div",{class:"g-view-toolbar"},el("a",{class:"btn small-btn",attrs:{id:"guest-view-switch",href:"#guest-tools"},text:t("qc_tools")}));
    (app.querySelector(".staff-head") || app).appendChild(toolbar);
    tilesNode = tiles();
    var list=el("section",{attrs:{id:"guest-list-view"}},tilesNode,findCard());
    var tools=el("section",{class:"g-tool-grid",attrs:{id:"guest-tools-view"}},
      toolPanel(holdsNode=holdsCard()),toolPanel(refundsNode=refundsCard()),toolPanel(issueCard()),toolPanel(importCard()),toolPanel(announceCard()),toolPanel(scannersNode=scanners()),toolPanel(manualCard()));
    app.appendChild(list);app.appendChild(tools);showGuestView();
  }

  async function loadStats() {
    var r = await Sahra.api.get("/api/party/stats");
    if (!r.ok) return;
    stats = r.body;
    if (tilesNode && tilesNode.parentNode) { var n = tiles(); tilesNode.parentNode.replaceChild(n, tilesNode); tilesNode = n; }
  }

  function refreshTickets() { if ((query || Array.isArray(found)) && found !== "loading") search(query); loadStats(); }
  window.addEventListener("storage", function (e) { if (e.key === "sahra_ticket_change") refreshTickets(); });
  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible") refreshTickets(); });

  var first = true;
  SahraStaff.start({
    page: "guests", title: "g_title", lede: "g_lede",
    render: function (me, app) {
      render(me, app);
      if (!first) return;
      first = false;
      Promise.all([Sahra.api.get("/api/party/stats"), Sahra.api.get("/api/tickets/types"), Sahra.api.get("/api/scan/manual"),
        Sahra.api.get("/api/party/refunds"), Sahra.api.get("/api/party")]).then(function (rs) {
        if (rs[2].ok) manualAdmits = rs[2].body.admits || [];
        if (rs[3].ok) refunds = rs[3].body;
        if (rs[4].ok) party = rs[4].body;
        if (rs[0].ok) stats = rs[0].body;
        if (rs[1].ok) types = rs[1].body.types || [];
        S.redraw();
        // Opened from the dashboard's "Find a guest" (/guests.html?q=...): run that search.
        var q0 = (new URLSearchParams(location.search).get("q") || "").trim().slice(0, 80);
        if (q0.length >= 2) {
          search(q0);
          var finder = document.getElementById("find");
          if (finder && finder.scrollIntoView) finder.scrollIntoView({ block: "start" });
        }
        if (q0.length < 2) search("");
        setInterval(function () { if (document.visibilityState === "visible") loadStats(); }, 60000);
        if (me.staff.role === "owner") loadHolds();
      });
    },
  });
})();
