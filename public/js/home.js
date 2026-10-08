// Home page (owner decisions): a full-width hero with the party photos in a grid
// behind the heading and the "Discover parties" button, then the upcoming parties as a grid of cards, then
// a short "About Sahra", then the footer; sign-in for organisers and staff sits
// at the top right. A party card shows this browser's own ticket for that party
// when it remembers one (brainstorm idea 4): the links saved by the sign-up and
// ticket pages (localStorage sahra_tickets), checked in one call.
//
// Photos live in /img/hero (hero-1.jpg ... hero-9.jpg), compressed and slightly
// blurred before they are added; all nine sit behind the hero, 6-9 also on cards. A photo that is missing is removed and the
// tile keeps its gradient, so the page never shows a broken image.
"use strict";
(function () {
  var t = Sahra.t, el = Sahra.el;
  var app = document.getElementById("app");
  var parties = null, failed = null;
  var mine = [];          // [{ link, status, party_id, party_name, starts_at, time_zone }]
  var heroBox = document.getElementById("hero");
  var HERO = [1, 2, 3, 4, 5, 6, 7, 8, 9]; // the grid behind the hero (the first tile is large)
  var COVERS = [6, 7, 8, 9];           // party cards, in turn, until parties have their own flyers

  function remembered() {
    try {
      var list = JSON.parse(Sahra.store.get("sahra_tickets") || "[]");
      return Array.isArray(list) ? list.filter(function (x) { return x && typeof x.link === "string"; }) : [];
    } catch (e) { return []; }
  }
  function tokenOf(link) { return (link.split("#t=")[1] || "").trim(); }

  function datePart(ms, tz, opt) {
    var loc = Sahra.lang() === "ar" ? "ar-EG-u-nu-latn" : "en-GB";
    try { return new Intl.DateTimeFormat(loc, Object.assign({ timeZone: tz || undefined }, opt)).format(ms); } catch (e) { return ""; }
  }

  function photo(n, eager) {
    var img = el("img", { attrs: { src: "/img/hero/hero-" + n + ".jpg", alt: "", decoding: "async", loading: eager ? "eager" : "lazy" } });
    img.addEventListener("error", function () { img.remove(); });
    return img;
  }

  function statePill(p) {
    if (p.state === "full") return el("span", { class: "pill no", text: t("h_state_full") });
    if (p.state === "not_open_yet") return el("span", { class: "pill", text: t("h_state_not_open_yet", { rel: Sahra.rel(p.opens_at) }) });
    if (p.state === "closed") return el("span", { class: "pill", text: t("h_state_closed") });
    return el("span", { class: "pill yes", text: t("h_state_open") });
  }
  function myPill(status) {
    var cls = status === "released" || status === "approved" ? "yes" : status === "rejected" || status === "cancelled" ? "no" : "maybe";
    return el("span", { class: "pill " + cls, text: t("h_your_ticket", { status: t("my_" + status) }) });
  }

  function heading(a, em, b) { return [a, el("span", { class: "serif", text: em }), b]; }

  function hero() {
    var shown = mine.filter(function (m) { return m.status !== "invalid"; });
    return el("section", { class: "hero" },
      el("div", { class: "hero-bg", attrs: { "aria-hidden": "true" } }, HERO.map(function (n, i) { return el("div", { class: "ph" }, photo(n, i < 5)); })),
      el("div", { class: "copy" },
        el("span", { class: "kicker", text: t("h_kicker") }),
        el("h1", null, heading(t("h_title_a"), t("h_title_em"), t("h_title_b"))),
        el("p", { text: t("h_sub") }),
        el("div", { class: "hero-actions" },
          el("a", { class: "btn primary", text: t("h_discover"), attrs: { href: "#parties" } }),
          shown.length
            ? el("a", { class: "btn", text: t("h_your_tickets"), attrs: { href: "#mine" } })
            : el("a", { class: "btn", text: t("h_how"), attrs: { href: "#about" } })),
        el("ul", { class: "facts-strip" }, [t("h_fact_1"), t("h_fact_2"), t("h_fact_3")].map(function (x) { return el("li", { text: x }); }))));
  }

  function card(p, i) {
    var my = mine.filter(function (m) { return m.party_id === p.id && m.status !== "invalid"; })[0];
    var href = my ? my.link : "/signup.html?party=" + encodeURIComponent(p.id);
    var a = el("a", { class: "party-card reveal", attrs: { href: href } },
      el("div", { class: "cover" },
        photo(COVERS[i % COVERS.length], false),
        el("div", { class: "date-block" },
          el("span", { class: "day", text: datePart(p.starts_at, p.time_zone, { day: "numeric" }) }),
          el("span", { class: "mon", text: datePart(p.starts_at, p.time_zone, { month: "short" }) }))),
      el("div", { class: "grow" },
        el("span", { class: "name", text: p.name, attrs: { dir: "auto" } }),
        el("span", { class: "meta", text: Sahra.when(p.starts_at, p.time_zone) }),
        p.from_price ? el("span", { class: "meta", text: t("h_from", { amount: Sahra.amount(p.from_price) }) }) : null,
        el("span", { class: "tags" }, my ? myPill(my.status) : statePill(p))));
    a.style.setProperty("--d", (i % 3) * 90 + "ms"); // CSSOM: allowed under the page's style policy
    return a;
  }

  function partiesSection() {
    var list = [el("div", { class: "section-head reveal", attrs: { id: "parties" } },
      el("div", null, el("span", { class: "kicker", text: t("h_upcoming_kicker") }), el("h2", { text: t("h_upcoming") })),
      parties && parties.length ? el("span", { class: "small muted", text: t("h_count", { n: parties.length }) }) : null)];
    if (failed) list.push(el("p", { class: "notice no", text: failed }));
    else if (!parties) list.push(el("p", { class: "muted", text: t("loading") }));
    else if (!parties.length) list.push(el("p", { class: "empty", text: t("h_none") }));
    else list.push(el("div", { class: "parties" }, parties.map(card)));
    return list;
  }

  function mineSection() {
    var shown = mine.filter(function (m) { return m.status !== "invalid"; });
    if (!shown.length) return null;
    return [el("div", { class: "section-head reveal", attrs: { id: "mine" } }, el("h2", { text: t("h_your_tickets") })),
      el("div", { class: "mine" }, shown.slice(0, 6).map(function (m) {
        return el("a", { attrs: { href: m.link } },
          el("span", null, el("strong", { text: m.party_name, attrs: { dir: "auto" } }), el("br"),
            el("span", { class: "small muted", text: m.starts_at ? Sahra.when(m.starts_at, m.time_zone) : "" })),
          myPill(m.status));
      }))];
  }

  function about() {
    var steps = [1, 2, 3].map(function (n) {
      var step = el("div", { class: "step reveal" },
        el("span", { class: "num", text: "0" + n }),
        el("h3", { text: t("h_step" + n + "_t") }),
        el("p", { text: t("h_step" + n + "_p") }));
      step.style.setProperty("--d", (n - 1) * 110 + "ms");
      return step;
    });
    return el("section", { class: "about reveal", attrs: { id: "about" } },
      el("span", { class: "corner tl" }), el("span", { class: "corner tr" }), el("span", { class: "corner bl" }), el("span", { class: "corner br" }),
      el("span", { class: "kicker", text: t("h_about_kicker") }),
      el("h2", null, heading(t("h_about_title_a"), t("h_about_title_em"), "")),
      el("p", { text: t("h_about_text") }),
      el("div", { class: "steps" }, steps),
      el("div", { class: "host" },
        el("div", null, el("h3", { text: t("h_host_t") }), el("p", { class: "muted", text: t("h_host_p") })),
        el("a", { class: "btn", text: t("sign_in"), attrs: { href: "/signin.html" } })));
  }

  function render() {
    Sahra.clear(app);
    document.title = "Sahra";
    Sahra.clear(heroBox).appendChild(hero());
    var m = mineSection();
    if (m) m.forEach(function (n) { app.appendChild(n); });
    partiesSection().forEach(function (n) { app.appendChild(n); });
    app.appendChild(about());
  }

  async function load() {
    var saved = remembered();
    var reqs = [Sahra.api.get("/api/guest/parties")];
    if (saved.length) reqs.push(Sahra.api.post("/api/guest/tickets/status", { links: saved.slice(0, 20).map(function (x) { return tokenOf(x.link); }) }));
    var rs = await Promise.all(reqs);
    if (rs[0].ok) parties = rs[0].body.parties; else failed = Sahra.errorText(rs[0]);
    if (rs[1] && rs[1].ok) {
      mine = rs[1].body.tickets.map(function (x, i) { return Object.assign({}, x, { link: saved[i].link }); });
      // Forget links that no longer work (replaced by a newer one).
      var keep = saved.filter(function (s, i) { return !mine[i] || mine[i].status !== "invalid"; });
      if (keep.length !== saved.length) Sahra.store.set("sahra_tickets", JSON.stringify(keep));
    }
    render();
  }

  Sahra.boot({ render: render });
  load();
})();
