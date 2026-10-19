// Organiser dashboard: /dashboard.html (owner and admin; door staff go to the
// scanner). Owner: "looks bland", after an analytics dashboard reference: the
// party and its main actions on top; four stat cards, each with a small visual
// (approved against capacity, requests in the last 7 days, revenue approved and
// pending, checked in or the countdown); then the requests chart large, with
// quick actions and tickets by type beside it, and arrivals once doors open.
// Numbers come from GET /api/party/stats, which reads the party's tickets: the
// page refreshes once a minute at most, and only while it is visible.
"use strict";
(function () {
  var t = Sahra.t, el = Sahra.el;
  var app = document.getElementById("app");
  var me = null, party = null, stats = null, admission = null, updatedAt = null;
  var busy = false;
  var drawn = false;      // the bars grow in on the first drawing only, not on every refresh
  var REFRESH_MS = 60000;
  var mobileTab = "overview";

  // A stat card: label, the number, a line under it, and a small visual.
  function tile(label, big, sub, visual) {
    return el("div", { class: "tile stat" }, el("div", { class: "label", text: label }),
      el("div", { class: "big", text: big }), sub ? el("div", { class: "sub", text: sub }) : null, visual || null);
  }
  // A thin bar: parts [{ value, cls }] out of `of` (CSSOM widths: allowed by the page policy).
  function meter(parts, of) {
    var bar = el("div", { class: "meter", attrs: { "aria-hidden": "true" } });
    parts.forEach(function (p) {
      var seg = el("span", { class: p.cls || "" });
      seg.style.width = (of > 0 ? Math.min(100, (100 * p.value) / of) : 0) + "%";
      bar.appendChild(seg);
    });
    return bar;
  }

  function tiles() {
    var s = stats;
    var started = party && party.starts_at && party.starts_at <= Date.now();
    var doorsOpen = admission && admission.open;
    var C = window.SahraCharts;
    var week = C ? C.perDay(s, party, 7).map(function (d) { return d.value; }) : [];
    var weekTotal = week.reduce(function (n, v) { return n + v; }, 0);
    var pct = s.capacity > 0 ? Math.round((100 * s.approved) / s.capacity) : 0;
    var fourth = doorsOpen || started || s.inside > 0
      ? tile(t("d_inside"), String(s.inside), t("d_of_approved", { n: s.approved }), meter([{ value: s.inside, cls: "yes" }], s.approved))
      : tile(t("d_starts"), party && party.starts_at ? Sahra.rel(party.starts_at) : "-", party && party.starts_at ? Sahra.when(party.starts_at, party.time_zone) : null);
    var money = s.money_expected + (s.money_pending || 0);
    return el("div", { class: "tiles stats" },
      tile(t("d_approved"), String(s.approved), t("d_of_capacity_pct", { cap: s.capacity, p: pct }), meter([{ value: s.approved }], s.capacity)),
      tile(t("d_waiting"), String(s.pending_requests), t("d_week_n", { n: weekTotal }), C ? C.spark(week, C.palette[0]) : null),
      tile(t("d_money"), Sahra.amount(s.money_expected), [s.money_cash ? t("d_money_cash", { amount: Sahra.amount(s.money_cash) }) : null,
          s.money_pending ? t("d_money_pending", { amount: Sahra.amount(s.money_pending) }) : (s.money_cash ? null : t("d_money_none"))].filter(Boolean).join(" \u00b7 "),
        money ? meter([{ value: s.money_expected }, { value: s.money_pending || 0, cls: "pending" }], money) : null),
      fourth);
  }

  // Phone overview follows the compact app layout; desktop keeps its charts
  // and original metric row. Every figure uses the same live stats response.
  function mobileOverview() {
    var C = window.SahraCharts;
    var week = C ? C.perDay(stats, party, 7).map(function (d) { return d.value; }) : [];
    function metric(label, value, sub, href, cls) {
      return el("a", {class:"dm-metric " + (cls || ""),attrs:{href:href}},
        el("span",{class:"label",text:label}),el("strong",{text:value}),el("span",{class:"small muted",text:sub}));
    }
    return el("section",{class:"dash-mobile-overview",attrs:{"aria-label":t("dm_overview")}},
      el("div",{class:"dm-hero"},
        el("div",{class:"dm-hero-top"},el("span",{class:"label",text:t("d_inside")}),
          admission ? el("span",{class:"pill " + (admission.open?"yes":"maybe"),text:t(admission.open?"d_doors_open":"d_doors_paused")}):null),
        el("div",{class:"dm-capacity"},el("strong",{text:String(stats.inside)}),el("span",{text:"/ " + stats.capacity})),
        el("p",{class:"muted small",text:t("dm_capacity_hint",{approved:stats.approved,left:stats.places_left})}),
        meter([{value:stats.inside,cls:"yes"}],stats.capacity)),
      el("div",{class:"dm-grid"},
        metric(t("d_waiting"),String(stats.pending_requests),t("dm_review_hint"),"/queue.html","dm-waiting"),
        metric(t("d_approved"),String(stats.approved),t("dm_active_hint"),"/guests.html?status=approved","dm-guests"),
        metric(t("dm_ready"),String(stats.released),t("dm_ready_hint"),"/guests.html?status=approved&delivery=released","dm-ready"),
        metric(t("d_money"),new Intl.NumberFormat(Sahra.lang()==="ar"?"ar-EG-u-nu-latn":"en-GB").format(stats.money_expected),t("dm_revenue_hint"),"/guests.html?status=approved","dm-revenue")),
      el("nav",{class:"dm-shortcuts",attrs:{"aria-label":t("dm_shortcuts")}},
        [["d_find_t","/guests.html#find"],["dm_add_guest","/guests.html#issue"],["dm_email_shortcut","/outbox.html"]].map(function(x){return el("a",{class:"btn",text:t(x[0]),attrs:{href:x[1]}});})),
      el("div",{class:"dm-trend"},el("div",null,el("span",{class:"label",text:t("dm_week")}),
        el("strong",{text:String(week.reduce(function(a,b){return a+b;},0))})),C?C.spark(week,C.palette[0]):null));
  }

  async function doors(action) {
    if (busy) return;
    if (action === "pause" && !(await Sahra.confirm(t("d_pause_confirm"), { danger: true }))) return;
    busy = true;
    render();
    // A pending answer (503) is retried with the same body, as everywhere else.
    for (var i = 0; i < 5; i++) {
      var r = await Sahra.api.post("/api/admission", { action: action });
      if (r.status !== 503) break;
      await new Promise(function (ok) { setTimeout(ok, 1500); });
    }
    busy = false;
    if (!r.ok) await Sahra.notify(Sahra.errorText(r));
    await load();
  }

  // The three things done most on the night, beside the party's name.
  function headActions() {
    var list = [];
    list.push(el("a", { class: "btn primary small-btn dash-review", text: stats.pending_requests > 0 ? t("d_review_n", { n: stats.pending_requests }) : t("d_review"), attrs: { href: "/queue.html" } }));
    if (admission) {
      list.push(admission.open
        ? el("button", { class: "btn no small-btn dash-admission", text: t(busy ? "loading" : "d_pause_doors"), attrs: { type: "button", disabled:busy, title:t("d_admission_help") }, on: { click: function () { doors("pause"); } } })
        : el("button", { class: "btn yes small-btn dash-admission", text: t(busy ? "loading" : "d_open_doors"), attrs: { type: "button", disabled:busy, title:t("d_admission_help") }, on: { click: function () { doors("open"); } } }));
    }
    list.push(el("a", { class: "btn small-btn dash-scan", text: t("d_scanner"), attrs: { href: "/scan.html" } }));
    return el("div", { class: "dash-actions" }, list);
  }

  // Everything else, as a list with a line on what each page is for.
  function quickActions() {
    var rows = [["d_qa_queue", "/queue.html"], ["d_guests", "/guests.html"], ["d_settings", "/party.html"], ["d_outbox", "/outbox.html"]];
    if (me.staff.role === "owner") rows.push(["d_tools", "/tools.html"]);
    return el("section", { class: "card quick" }, el("div", { class: "chart-head" }, el("h2", { text: t("d_quick") })),
      el("ul", null, rows.map(function (r) {
        return el("li", null, el("a", { attrs: { href: r[1] } },
          el("span", { class: "qa-text" }, el("strong", { text: t(r[0]) }), el("span", { class: "muted", text: t(r[0] + "_p") })),
          el("span", { class: "qa-go", attrs: { "aria-hidden": "true" } })));
      })));
  }

  // "Find a guest": opens the Guests page with this search (the page refreshes every minute,
  // so what is typed and the cursor are kept across a refresh).
  var findText = "";
  function findGuest() {
    var input = el("input", { attrs: { id: "d-find", type: "search", value: findText, placeholder: t("d_find_ph"), "aria-label": t("d_find_t"),
      minlength: 2, maxlength: 80, autocomplete: "off", enterkeyhint: "search", dir: "auto", "data-find": "" } });
    input.addEventListener("input", function () { findText = input.value; });
    var f = el("form", { class: "find-box dash-find", attrs: { role: "search", action: "/guests.html", method: "get" } }, input,
      el("button", { class: "btn primary small-btn", text: t("d_find_go"), attrs: { type: "submit" } }));
    f.addEventListener("submit", function (e) {
      e.preventDefault();
      var q = input.value.trim();
      if (q.length < 2) { input.focus(); return; }
      location.href = "/guests.html?q=" + encodeURIComponent(q);
    });
    return f;
  }

  function render() {
    var firstLayout = !drawn;
    var typing = document.activeElement && document.activeElement.id === "d-find";
    var caret = typing ? document.activeElement.selectionStart : null;
    Sahra.clear(app);
    if (!me) { app.appendChild(Sahra.problem({ kicker: t("nt_kicker_signin"), title: t("nt_staff_t"), text: t("d_sign_in"),
      actions: [[t("sign_in"), "/signin", true], [t("nt_home"), "/"]], hint: t("nt_guest_hint") })); return; }
    if (!stats) { app.appendChild(el("p", { class: "muted", text: t("loading") })); return; }
    app.classList.add("dash");
    app.setAttribute("data-mobile-tab",mobileTab);
    if (window.SahraStaff) SahraStaff.workspace(app,"dashboard", me.staff.role);
    var when = party && party.starts_at ? Sahra.when(party.starts_at, party.time_zone) : null;
    app.appendChild(el("header", { class: "dash-head" },
      el("div", null,
        el("p", { class: "label-line", text: t("d_label") }),
        el("h1", { text: party ? party.name : me.party.name, attrs: { dir: "auto" } }),
        el("p", { class: "dash-meta" }, when ? el("span", { text: when }) : null,
          admission ? el("span", { class: "pill " + (admission.open ? "yes" : "maybe"), text: admission.open ? t("d_doors_open") : t("d_doors_paused") }) : null)),
      headActions()));
    app.appendChild(el("div", { class: "notice dash-warn" }, el("p", { text: t("d_admission_help") }), el("a", { class: "btn small-btn", text: t("d_request_settings"), attrs: { href: "/party.html#requests" } })));
    if (party && party.cancelled_at) app.appendChild(el("div", { class: "notice no dash-warn" },
      el("p", { text: t("d_cancelled", { when: Sahra.when(party.cancelled_at, party.time_zone) }) }),
      el("a", { class: "btn small-btn", text: t("s_open_refunds"), attrs: { href: "/guests.html#refunds" } })));
    // Requests stay closed until the party has a contact number (brainstorm idea 16).
    else if (party && !party.support_phone) app.appendChild(el("div", { class: "notice maybe dash-warn" },
      el("p", { text: t("d_contact_missing") }), el("a", { class: "btn small-btn", text: t("d_contact_add"), attrs: { href: "/party.html#contact" } })));
    if (me.staff.role !== "door") app.appendChild(findGuest());
    var mobileTabs = [["overview","dm_tab_overview"],["activity","dm_tab_activity"],["types","dm_tab_types"]];
    function chooseMobileTab(key) { mobileTab=key;render();var selected=document.getElementById("dm-tab-"+key);if(selected)selected.focus({preventScroll:true}); }
    app.appendChild(el("div",{class:"dm-tabs",attrs:{role:"tablist","aria-label":t("dm_overview")}},mobileTabs.map(function(x,index){
      var button=el("button",{text:t(x[1]),attrs:{type:"button",role:"tab",id:"dm-tab-"+x[0],"aria-selected":mobileTab===x[0]?"true":"false","aria-controls":"dm-panel-"+x[0],tabindex:mobileTab===x[0]?0:-1},on:{click:function(){chooseMobileTab(x[0]);}}});
      button.addEventListener("keydown",function(e){var n=index;if(e.key==="Home")n=0;else if(e.key==="End")n=2;else if(e.key==="ArrowRight"||e.key==="ArrowLeft")n=(index+(e.key==="ArrowRight"?1:-1)*(document.documentElement.dir==="rtl"?-1:1)+3)%3;else return;e.preventDefault();chooseMobileTab(mobileTabs[n][0]);});
      return button;
    })));
    var overview=mobileOverview();overview.id="dm-panel-overview";overview.setAttribute("role","tabpanel");overview.setAttribute("aria-labelledby","dm-tab-overview");app.appendChild(overview);
    app.appendChild(tiles());
    var C = window.SahraCharts;
    var charts = el("div", { class: "charts" + (drawn ? "" : " animate"), attrs: { id: "charts" } });
    drawn = true;
    if (C) {
      var types = C.types(stats);
      charts.appendChild(el("div", { class: "dash-main" },
        el("div",{class:"dm-activity-panel",attrs:{id:"dm-panel-activity",role:"tabpanel","aria-labelledby":"dm-tab-activity"}},C.requests(stats,party,true),C.arrivals(stats,party)),
        el("div", { class: "dash-pair dm-types-panel",attrs:{id:"dm-panel-types",role:"tabpanel","aria-labelledby":"dm-tab-types"} }, types || el("p",{class:"muted",text:t("dm_no_types")}))));
      charts.appendChild(el("div", { class: "dash-side" }, quickActions()));
    } else {
      charts.appendChild(quickActions());
    }
    app.appendChild(charts);
    if (updatedAt) app.appendChild(el("p", { class: "small muted center", text: t("d_updated", { time: Sahra.time(updatedAt) }) }));
    if (firstLayout) Sahra.reveal(app);
    if (typing) { var box = document.getElementById("d-find"); if (box) { box.focus(); try { box.setSelectionRange(caret, caret); } catch (x) { /* not a text field */ } } }
  }

  async function load() {
    var rs = await Promise.all([Sahra.api.get("/api/party/stats"), Sahra.api.get("/api/admission"), party ? null : Sahra.api.get("/api/party")]);
    if (rs[0].ok) { stats = rs[0].body; updatedAt = Date.now(); }
    if (rs[1].ok) admission = rs[1].body;
    if (rs[2] && rs[2].ok) party = rs[2].body;
    render();
  }

  (async function () {
    me = await Sahra.api.me();
    if (me && me.staff.role === "door") { location.href = "/scan.html"; return; }
    Sahra.boot({ render: render, me: me });
    if (!me) return;
    await load();
    setInterval(function () { if (document.visibilityState === "visible") load(); }, REFRESH_MS);
  })();
})();
