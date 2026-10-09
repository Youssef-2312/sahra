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

  async function doors(action) {
    if (busy) return;
    if (action === "pause" && !window.confirm(t("d_pause_confirm"))) return;
    busy = true;
    // A pending answer (503) is retried with the same body, as everywhere else.
    for (var i = 0; i < 5; i++) {
      var r = await Sahra.api.post("/api/admission", { action: action });
      if (r.status !== 503) break;
      await new Promise(function (ok) { setTimeout(ok, 1500); });
    }
    busy = false;
    if (!r.ok) window.alert(Sahra.errorText(r));
    await load();
  }

  // The three things done most on the night, beside the party's name.
  function headActions() {
    var list = [];
    list.push(el("a", { class: "btn primary small-btn", text: stats.pending_requests > 0 ? t("d_review_n", { n: stats.pending_requests }) : t("d_review"), attrs: { href: "/queue.html" } }));
    if (admission) {
      list.push(admission.open
        ? el("button", { class: "btn no small-btn", text: t("d_pause_doors"), attrs: { type: "button" }, on: { click: function () { doors("pause"); } } })
        : el("button", { class: "btn yes small-btn", text: t("d_open_doors"), attrs: { type: "button" }, on: { click: function () { doors("open"); } } }));
    }
    list.push(el("a", { class: "btn small-btn", text: t("d_scanner"), attrs: { href: "/scan.html" } }));
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

  function render() {
    Sahra.clear(app);
    if (!me) { app.appendChild(Sahra.problem({ kicker: t("nt_kicker_signin"), title: t("nt_staff_t"), text: t("d_sign_in"),
      actions: [[t("sign_in"), "/signin", true], [t("nt_home"), "/"]], hint: t("nt_guest_hint") })); return; }
    if (!stats) { app.appendChild(el("p", { class: "muted", text: t("loading") })); return; }
    app.classList.add("dash");
    if (window.SahraStaff) app.appendChild(SahraStaff.nav("dashboard", me.staff.role));
    var when = party && party.starts_at ? Sahra.when(party.starts_at, party.time_zone) : null;
    app.appendChild(el("header", { class: "dash-head" },
      el("div", null,
        el("p", { class: "label-line", text: t("d_label") }),
        el("h1", { text: party ? party.name : me.party.name, attrs: { dir: "auto" } }),
        el("p", { class: "dash-meta" }, when ? el("span", { text: when }) : null,
          admission ? el("span", { class: "pill " + (admission.open ? "yes" : "maybe"), text: admission.open ? t("d_doors_open") : t("d_doors_paused") }) : null)),
      headActions()));
    if (party && party.cancelled_at) app.appendChild(el("div", { class: "notice no dash-warn" },
      el("p", { text: t("d_cancelled", { when: Sahra.when(party.cancelled_at, party.time_zone) }) }),
      el("a", { class: "btn small-btn", text: t("s_open_refunds"), attrs: { href: "/guests.html#refunds" } })));
    // Requests stay closed until the party has a contact number (brainstorm idea 16).
    else if (party && !party.support_phone) app.appendChild(el("div", { class: "notice maybe dash-warn" },
      el("p", { text: t("d_contact_missing") }), el("a", { class: "btn small-btn", text: t("d_contact_add"), attrs: { href: "/party.html#contact" } })));
    app.appendChild(tiles());
    var C = window.SahraCharts;
    var charts = el("div", { class: "charts" + (drawn ? "" : " animate"), attrs: { id: "charts" } });
    drawn = true;
    if (C) {
      var types = C.types(stats);
      charts.appendChild(el("div", { class: "dash-main" }, C.requests(stats, party, true), C.arrivals(stats, party),
        types ? el("div", { class: "dash-pair" }, types) : null));
      charts.appendChild(el("div", { class: "dash-side" }, quickActions()));
    } else {
      charts.appendChild(quickActions());
    }
    app.appendChild(charts);
    if (updatedAt) app.appendChild(el("p", { class: "small muted center", text: t("d_updated", { time: Sahra.time(updatedAt) }) }));
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
