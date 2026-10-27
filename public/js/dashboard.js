// NovaHub-style organiser workspace. The server remains authoritative for
// ticket, payment and admission state. Tabs and date ranges only change views.
"use strict";
(function () {
  var t = Sahra.t, el = Sahra.el, S = SahraStaff;
  var app = document.getElementById("app");
  var me = null, party = null, stats = null, admission = null;
  var busy = false, refreshing = false, syncError = false, admissionVerified = false;
  var updatedAt = null, fetchedAt = null, drawn = false, findText = "", controlsOpen = false;
  var initial = new URLSearchParams(location.search);
  var activeTab = ["overview", "activity", "types", "insights"].includes(initial.get("view")) ? initial.get("view") : "overview";
  var days = initial.get("days") === "7" ? 7 : 14;
  var TABS = [["overview", "dm_tab_overview"], ["activity", "dm_tab_activity"], ["types", "dm_tab_types"], ["insights", "fi_title"]];
  var REFRESH_MS = 60000;

  function rememberView() {
    var u = new URL(location.href);
    if (activeTab === "overview") u.searchParams.delete("view"); else u.searchParams.set("view", activeTab);
    if (days === 14) u.searchParams.delete("days"); else u.searchParams.set("days", String(days));
    history.replaceState(null, "", u);
  }

  function syncText() {
    if (refreshing) return t("sh_syncing");
    if (syncError) return t("sh_sync_failed");
    if (fetchedAt === null) return t("sh_not_synced");
    var age = Math.max(0, Math.floor((performance.now() - fetchedAt) / 1000));
    if (age >= 120) return t("sh_sync_stale");
    return age < 10 ? t("sh_synced_now") : t("sh_synced_seconds", { n: age });
  }
  function updateSync() {
    var n = document.getElementById("dash-sync-label");
    if (!n) return;
    n.textContent = syncText();
    n.parentElement.classList.toggle("is-stale", syncError || (fetchedAt !== null && performance.now() - fetchedAt >= 120000));
    var refresh = document.getElementById("dash-refresh");
    if (refresh) { refresh.disabled = refreshing || busy; refresh.setAttribute("aria-busy", refreshing ? "true" : "false"); }
    var doorButton = document.getElementById("dash-admission");
    if (doorButton) doorButton.disabled = refreshing || busy || !admissionVerified;
  }

  function header() {
    return el("header", { class: "dash-head sh-dash-head" },
      el("div", { class: "sh-heading" }, el("p", { class: "label-line", text: t("sh_workspace") }),
        el("h1", { text: party ? party.name : me.party.name, attrs: { dir: "auto" } }),
        el("p", { class: "dash-meta" },
          party && party.starts_at ? el("span", { text: Sahra.when(party.starts_at, party.time_zone) }) : null,
          el("span", { class: "pill " + (admissionVerified && admission ? (admission.open ? "yes" : "maybe") : ""), text: t(admissionVerified && admission ? (admission.open ? "d_doors_open" : "d_doors_paused") : "sh_admission_unknown") }))),
      el("div", { class: "sh-sync" },
        el("span", { class: "sh-sync-text", attrs: { title: updatedAt ? Sahra.when(updatedAt, party && party.time_zone) + " · " + (party && party.time_zone || "UTC") : null } },
          el("span", { class: "sh-sync-dot", attrs: { "aria-hidden": "true" } }),
          el("span", { attrs: { id: "dash-sync-label", role: "status", "aria-live": "polite" }, text: syncText() })),
        el("button", { class: "sh-icon-btn", attrs: { id: "dash-refresh", type: "button", "aria-label": t("sh_refresh"), title: t("sh_refresh"), disabled: refreshing || busy }, on: { click: load } }, S.icon("refresh"))));
  }

  function tabs() {
    return S.viewPicker("dashboard-view",TABS.map(function(x){return [x[0],t(x[1])];}),activeTab,function(key){activeTab=key;rememberView();render();if(key === "insights")SahraFormInsights.refresh();document.getElementById("dashboard-view").focus({preventScroll:true});});
  }
  function panel(key) {
    return el("section",{class:"sh-dash-panel",hidden:activeTab!==key,attrs:{id:"dm-panel-"+key,"aria-label":t(TABS.find(function(x){return x[0]===key;})[1])}});
  }

  function ranges() {
    return el("div", { class: "sh-ranges", attrs: { role: "group", "aria-label": t("sh_request_period") } }, [7, 14].map(function (n) {
      return el("button", { class: "sh-range", text: t("sh_last_days", { n: n }), attrs: { id: "sh-range-" + n, type: "button", "aria-pressed": days === n ? "true" : "false" }, on: { click: function () { days = n; rememberView(); render(); document.getElementById("sh-range-" + n).focus({ preventScroll: true }); } } });
    }));
  }

  // A semicircle like NovaHub's main gauge, with an accessible text value.
  function capacityGauge() {
    var pct = stats.capacity > 0 ? Math.round(stats.approved / stats.capacity * 100) : 0;
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 240 135"); svg.setAttribute("aria-hidden", "true");
    var rail = document.createElementNS(svg.namespaceURI, "path");
    rail.setAttribute("d", "M20 120a100 100 0 0 1 200 0");
    rail.setAttribute("fill", "none"); rail.setAttribute("stroke", "#303238"); rail.setAttribute("stroke-width", "16");
    svg.appendChild(rail);
    var fill = rail.cloneNode(); fill.setAttribute("stroke", "#9ba9ff"); fill.setAttribute("pathLength", "100");
    fill.setAttribute("stroke-dasharray", Math.max(0, Math.min(100, pct)) + " 100"); svg.appendChild(fill);
    return el("div", { class: "sh-gauge" }, el("div", { class: "sh-gauge-art" }, svg,
      el("strong", { text: pct + "%" })), el("p", { text: t("sh_capacity_filled") }),
      el("span", { class: "sh-dark-muted", text: t("d_of_capacity_pct", { cap: stats.capacity, p: pct }) }));
  }

  function analytics() {
    var C = window.SahraCharts;
    var summary = el("div", { class: "sh-hero-numbers" },
      el("a", { attrs: { href: "/guests.html?status=approved" } }, el("strong", { text: String(stats.approved) }), el("span", { text: t("d_approved") }), el("small", { text: t("dm_active_hint") })),
      el("a", { attrs: { href: "/guests.html?status=approved&entry=used" } }, el("strong", { text: String(stats.inside) }), el("span", { text: t("d_inside") }), el("small", { text: t("d_of_approved", { n: stats.approved }) })));
    var chart = C ? C.requests(stats, party, true, days) : el("p", { text: t("dm_no_types") });
    chart.classList.add("sh-hero-chart");
    return el("section", { class: "sh-analytics", attrs: { "aria-label": t("sh_at_a_glance") } }, chart, capacityGauge(), summary);
  }

  function metric(label, value, hint, href, cls) {
    return el("a", { class: "sh-metric" + (cls ? " " + cls : ""), attrs: { href: href } }, el("span", { class: "sh-metric-label", text: label }),
      el("strong", { text: value }), el("span", { class: "sh-metric-hint", text: hint }), S.icon("arrow"));
  }
  function metrics() {
    return el("div", { class: "sh-metrics" },
      metric(t("d_waiting"), String(stats.pending_requests), t("dm_review_hint"), "/queue.html"),
      metric(t("d_money"), Sahra.amount(stats.money_expected), stats.money_pending ? t("d_money_pending", { amount: Sahra.amount(stats.money_pending) }) : t("dm_revenue_hint"), "/guests.html?status=approved", "sh-money"),
      metric(t("dm_ready"), String(stats.released), t("dm_ready_hint"), "/guests.html?status=approved&delivery=released"));
  }

  function findGuest() {
    var input = el("input", { attrs: { id: "d-find", type: "search", value: findText, placeholder: t("d_find_ph"), "aria-label": t("d_find_t"), minlength: 2, maxlength: 80, autocomplete: "off", enterkeyhint: "search", dir: "auto" } });
    input.addEventListener("input", function () { findText = input.value; });
    var f = el("form", { class: "sh-find", attrs: { role: "search", action: "/guests.html", method: "get" } }, input,
      el("button", { class: "btn primary small-btn", text: t("d_find_go"), attrs: { type: "submit" } }));
    f.addEventListener("submit", function (e) { e.preventDefault(); var q = input.value.trim(); if (q.length < 2) { input.focus(); return; } location.href = "/guests.html?q=" + encodeURIComponent(q); });
    return f;
  }

  function shortcut(label, hint, href, name) {
    return el("a", { class: "sh-shortcut", attrs: { href: href } }, S.icon(name), el("span", null, el("strong", { text: t(label) }), el("small", { text: t(hint) })), S.icon("arrow"));
  }
  function tasks() {
    return el("section", { class: "sh-card sh-tasks" }, el("div", { class: "sh-card-head" }, el("h2", { text: t("sh_next_actions") }),
      el("span", { class: "pill", text: t("sh_pending_count", { n: stats.pending_requests }) })),
      shortcut("d_review", "dm_review_hint", "/queue.html", "queue"),
      shortcut("dm_add_guest", "sh_add_guest_hint", "/guests.html#issue", "guests"),
      shortcut("s_nav_outbox", "sh_email_hint", "/outbox.html", "outbox"));
  }

  function eventControls() {
    var d = el("details", { class: "sh-event-controls" }, el("summary", null, el("span", { text: t("sh_event_controls") }), el("span", { class: "sh-summary-state", text: t(admissionVerified && admission ? (admission.open ? "d_doors_open" : "d_doors_paused") : "sh_admission_unknown") })),
      el("p", { class: "muted", text: t("d_admission_help") }),
      el("div", { class: "sh-control-actions" },
        el("button", { class: "btn small-btn" + (admissionVerified && admission ? (admission.open ? " no" : " yes") : ""), text: t(busy ? "loading" : admissionVerified && admission ? (admission.open ? "d_pause_doors" : "d_open_doors") : "sh_admission_unknown"), attrs: { id: "dash-admission", type: "button", disabled: busy || refreshing || !admissionVerified }, on: { click: function () { if (admissionVerified && admission) doors(admission.open ? "pause" : "open"); } } }),
        el("a", { class: "btn small-btn", text: t("d_scanner"), attrs: { href: "/scan.html" } }),
        el("a", { class: "btn small-btn", text: t("d_request_settings"), attrs: { href: "/party.html#requests" } })));
    d.open = controlsOpen; d.addEventListener("toggle", function () { if (d.isConnected) controlsOpen = d.open; }); return d;
  }

  function warnings(root) {
    if (party && party.cancelled_at) root.appendChild(el("div", { class: "notice no" }, el("p", { text: t("d_cancelled", { when: Sahra.when(party.cancelled_at, party.time_zone) }) }), el("a", { class: "btn small-btn", text: t("s_open_refunds"), attrs: { href: "/guests.html#refunds" } })));
    else if (party && !party.support_phone) root.appendChild(el("div", { class: "notice maybe" }, el("p", { text: t("d_contact_missing") }), el("a", { class: "btn small-btn", text: t("d_contact_add"), attrs: { href: "/party.html#contact" } })));
  }

  async function doors(action) {
    if (busy || refreshing || !admissionVerified) return;
    if (action === "pause" && !(await Sahra.confirm(t("d_pause_confirm"), { danger: true }))) return;
    busy = true; render();
    var r;
    try {
      for (var i = 0; i < 5; i++) { r = await Sahra.api.post("/api/admission", { action: action }); if (r.status !== 503) break; await S.sleep(1500); }
      if (!r.ok) await Sahra.notify(Sahra.errorText(r));
    } finally { busy = false; await load(); }
  }

  function render() {
    var focused = document.activeElement, typing = focused && focused.id === "d-find";
    var caret = typing ? focused.selectionStart : null;
    Sahra.clear(app);
    if (!me) { app.appendChild(Sahra.problem({ kicker: t("nt_kicker_signin"), title: t("nt_staff_t"), text: t("d_sign_in"), actions: [[t("sign_in"), "/signin", true], [t("nt_home"), "/"]], hint: t("nt_guest_hint") })); return; }
    app.classList.add("dash", "sh-dashboard"); S.workspace(app, "dashboard", me.staff.role); Sahra.title(t("s_nav_dashboard"));
    if (!stats) {
      app.appendChild(el("h1", { text: me.party.name, attrs: { dir: "auto" } }));
      app.appendChild(el("p", { class: "notice", attrs: { role: "status" }, text: t(syncError ? "sh_initial_failed" : "loading") }));
      if (syncError) app.appendChild(el("button", { class: "btn primary", text: t("sh_refresh"), attrs: { type: "button" }, on: { click: load } })); return;
    }
    app.appendChild(header()); warnings(app); app.appendChild(tabs());
    var overview = panel("overview");
    overview.appendChild(el("div", { class: "sh-period-row" }, el("p", { text: t("sh_request_period") }), ranges()));
    overview.appendChild(analytics()); overview.appendChild(metrics());
    overview.appendChild(el("div", { class: "sh-lower-grid" }, tasks(), el("section", { class: "sh-card sh-find-card" }, el("h2", { text: t("d_find_t") }), el("p", { class: "muted", text: t("sh_find_hint") }), findGuest())));
    overview.appendChild(eventControls()); app.appendChild(overview);
    var C = window.SahraCharts;
    var activity = panel("activity");
    activity.appendChild(el("div", { class: "sh-period-row" }, el("p", { text: t("sh_activity_hint") }), el("span", { class: "small muted", text: t("sh_fourteen_days") })));
    if (C) { activity.appendChild(C.requests(stats, party, true)); activity.appendChild(C.arrivals(stats, party) || el("section", { class: "sh-card" }, el("h2", { text: t("d_chart_arrivals") }), el("p", { class: "muted", text: t("sh_no_arrivals") }))); }
    app.appendChild(activity);
    var types = panel("types");
    types.appendChild(el("div", { class: "sh-period-row" }, el("p", { text: t("sh_types_hint") }), el("a", { class: "btn small-btn", text: t("sh_manage_types"), attrs: { href: "/party.html#types" } })));
    if (C) types.appendChild(C.types(stats) || el("p", { class: "notice", text: t("dm_no_types") }));
    if (stats.by_type && stats.by_type.length) {
      types.appendChild(el("div", { class: "sh-type-list" }, stats.by_type.map(function (row) {
        return el("a", { class: "sh-type-row", attrs: { href: "/guests.html?status=all" + (row.type_id ? "&type=" + encodeURIComponent(row.type_id) : "") } },
          el("strong", { text: row.name === "No type" ? t("d_no_type") : row.name, attrs: { dir: "auto" } }),
          el("span", { text: t("sh_type_counts", { approved: row.approved, pending: row.pending }) }), S.icon("arrow"));
      })));
    }
    app.appendChild(types);
    if(activeTab === "insights"){var insights=panel("insights");app.appendChild(insights);SahraFormInsights.mount(insights,me.party.id);}
    updateSync();
    if (!drawn) { Sahra.reveal(app); drawn = true; }
    if (typing) { var box = document.getElementById("d-find"); if (box && !box.closest("[hidden]")) { box.focus({ preventScroll: true }); try { box.setSelectionRange(caret, caret); } catch (_) {} } }
  }

  async function load(auto) {
    if (refreshing) return;
    refreshing = true; updateSync();
    try {
      var rs = await Promise.all([Sahra.api.get("/api/party/stats" + (auto === true ? "?auto=1" : "")), Sahra.api.get("/api/admission"), Sahra.api.get("/api/party")]);
      syncError = rs.some(function (r) { return !r.ok; });
      if (rs[0].ok) { stats = rs[0].body; updatedAt = Number.isFinite(stats.at) ? stats.at : Date.now(); fetchedAt = performance.now(); }
      admissionVerified = rs[1].ok;
      if (rs[1].ok) admission = rs[1].body;
      if (rs[2].ok) party = rs[2].body;
    } finally { refreshing = false; render(); if(activeTab === "insights")SahraFormInsights.refresh(); }
  }

  (async function () {
    me = await Sahra.api.me();
    if (me && me.staff.role === "door") { location.href = "/scan.html"; return; }
    Sahra.boot({ render: render, me: me });
    if (!me) return;
    await load();
    // Background refresh while the page is in use; paused when idle, caught up on the next action.
    setInterval(function () { if (document.visibilityState === "visible" && !Sahra.idle()) load(true); }, REFRESH_MS);
    Sahra.onWake(function () { if (document.visibilityState === "visible") load(); });
    setInterval(function () { if (document.visibilityState === "visible") updateSync(); }, 10000);
    document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible") { updateSync(); if (fetchedAt === null || performance.now() - fetchedAt >= REFRESH_MS) load(); } });
    window.addEventListener("popstate", function () { var p = new URLSearchParams(location.search); activeTab = TABS.some(function (x) { return x[0] === p.get("view"); }) ? p.get("view") : "overview"; days = p.get("days") === "7" ? 7 : 14; render(); });
  })();
})();
