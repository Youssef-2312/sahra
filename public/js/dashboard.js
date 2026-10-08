// Organiser dashboard: /dashboard.html (owner and admin; door staff go to the
// scanner). Brainstorm idea 10 and the owner's brief: one primary number at the
// top (approved out of capacity, or the people inside on the night), three
// secondary ones (requests waiting, money expected, the countdown or approved),
// then big buttons ("Review" first when requests wait), then the charts (idea 27).
// Numbers come from GET /api/party/stats, which reads the party's tickets: the
// page refreshes once a minute at most, and only while it is visible.
"use strict";
(function () {
  var t = Sahra.t, el = Sahra.el;
  var app = document.getElementById("app");
  var me = null, party = null, stats = null, admission = null, updatedAt = null;
  var busy = false;
  var REFRESH_MS = 60000;

  // One primary number (owner brief): before the night, approved out of capacity;
  // once the doors open or the party starts, the people inside out of approved.
  // Its bar fills to the real share, once, on the first load. Three secondary
  // numbers beside it. No counting-up animation: numbers are shown as they are.
  var filled = false;
  function metric(label, big, sub) {
    return el("div", { class: "metric" }, el("div", { class: "label", text: label }),
      el("div", { class: "big", text: big }), sub ? el("div", { class: "sub", text: sub }) : null);
  }
  function primary(label, value, of, sub, share) {
    var bar = el("span");
    bar.style.setProperty("--f", String(Math.max(0, Math.min(1, share)))); // CSSOM: allowed under the page's style policy
    var fill = el("div", { class: "fill" + (filled ? "" : " animate"), attrs: { role: "img", "aria-label": Math.round(share * 100) + "%" } }, bar);
    filled = true;
    return el("div", { class: "metric primary" }, el("div", { class: "label", text: label }),
      el("div", { class: "big" }, String(value), el("span", { class: "of", text: "/ " + of })),
      el("div", { class: "sub", text: sub }), fill);
  }

  function tiles() {
    var s = stats;
    var started = party && party.starts_at && party.starts_at <= Date.now();
    var night = (admission && admission.open) || started || s.inside > 0;
    var main = night
      ? primary(t("d_inside"), s.inside, s.approved, t("d_of_approved", { n: s.approved }), s.approved ? s.inside / s.approved : 0)
      : primary(t("d_approved"), s.approved, s.capacity, t("d_of_capacity", { cap: s.capacity }), s.capacity ? s.approved / s.capacity : 0);
    var third = night
      ? metric(t("d_approved"), String(s.approved), t("d_of_capacity", { cap: s.capacity }))
      : metric(t("d_starts"), party && party.starts_at ? Sahra.rel(party.starts_at) : "-", party && party.starts_at ? Sahra.when(party.starts_at, party.time_zone) : null);
    return el("section", { class: "metrics" }, main,
      el("div", { class: "secondary-metrics" },
        metric(t("d_waiting"), String(s.pending_requests)),
        metric(t("d_money"), Sahra.amount(s.money_expected), s.money_pending ? t("d_money_pending", { amount: Sahra.amount(s.money_pending) }) : null),
        third));
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

  function buttons() {
    var list = [];
    if (stats.pending_requests > 0) list.push(el("a", { class: "btn primary", text: t("d_review"), attrs: { href: "/queue.html" } }));
    if (admission) {
      list.push(admission.open
        ? el("button", { class: "btn no", text: t("d_pause_doors"), attrs: { type: "button" }, on: { click: function () { doors("pause"); } } })
        : el("button", { class: "btn yes", text: t("d_open_doors"), attrs: { type: "button" }, on: { click: function () { doors("open"); } } }));
    }
    list.push(el("a", { class: "btn", text: t("d_scanner"), attrs: { href: "/scan.html" } }));
    list.push(el("a", { class: "btn", text: t("d_guests"), attrs: { href: "/guests.html" } }));
    list.push(el("a", { class: "btn", text: t("d_settings"), attrs: { href: "/party.html" } }));
    list.push(el("a", { class: "btn", text: t("d_outbox"), attrs: { href: "/outbox.html" } }));
    if (me.staff.role === "owner") list.push(el("a", { class: "btn", text: t("d_tools"), attrs: { href: "/tools.html" } }));
    return el("div", { class: "stack buttons" }, list);
  }

  function render() {
    Sahra.clear(app);
    if (!me) { app.appendChild(el("p", { class: "notice maybe", text: t("d_sign_in") })); return; }
    if (!stats) { app.appendChild(el("p", { class: "muted", text: t("loading") })); return; }
    app.appendChild(el("div", { class: "row" },
      el("h1", { text: party ? party.name : me.party.name, attrs: { dir: "auto" } }),
      admission ? el("span", { class: "pill " + (admission.open ? "yes" : "maybe"), text: admission.open ? t("d_doors_open") : t("d_doors_paused") }) : null));
    app.appendChild(tiles());
    app.appendChild(buttons());
    var charts = el("div", { class: "charts", attrs: { id: "charts" } });
    app.appendChild(charts);
    if (window.SahraCharts) window.SahraCharts.draw(charts, stats, party);
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
