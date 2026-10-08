// Home page. North star: a guest sees how soon the next party is and how to get
// in, and trusts that the ticket is real.
//
//   Hero: the number is the hero: days (or hours) until the next party, beside a
//         moon that waxes to match (fuller as the night gets closer: the logo's
//         crescent becomes a full moon on the night). One primary action:
//         request a ticket for that party (or view yours). Three secondary
//         numbers, all real and from the public party list: parties on the
//         calendar, parties taking requests now, the lowest ticket price.
//   Then: the parties as a printed programme (one ruled row per night), the
//         guest's own remembered tickets, how a Sahra ticket works, the footer.
//
// The guest's own ticket status (brainstorm idea 4) comes from the links saved
// by the sign-up and ticket pages (localStorage sahra_tickets), checked in one
// call. Photos in /img/hero (hero-1.jpg ... hero-9.jpg) sit behind the hero as a
// monochrome texture; a missing photo is removed and the tile stays plain.
// Motion: the hero's staggered reveal plays once, when the numbers arrive; a
// language switch redraws it without replaying.
"use strict";
(function () {
  var t = Sahra.t, el = Sahra.el;
  var app = document.getElementById("app");
  var heroBox = document.getElementById("hero");
  var parties = null, failed = null, loaded = false, revealed = false;
  var mine = [];          // [{ link, status, party_id, party_name, starts_at, time_zone }]
  var PHOTOS = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  var NS = "http://www.w3.org/2000/svg";
  var DAY = 86400000, HOUR = 3600000;
  var MOON_WINDOW = 14 * DAY;   // two weeks out the moon is a thin crescent; on the night it is full

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
  /** "day" / "days" (Arabic has more forms: one, two, few, many). */
  function unit(n, kind) {
    var cat = "other";
    try { cat = new Intl.PluralRules(Sahra.lang() === "ar" ? "ar" : "en").select(n); } catch (e) {}
    var key = "h_unit_" + kind + "_" + cat;
    var has = (SahraText[Sahra.lang()] || {})[key] !== undefined || SahraText.en[key] !== undefined;
    return t(has ? key : "h_unit_" + kind + "_other");
  }
  function pad(n) { return n < 10 ? "0" + n : String(n); }
  /** A sentence with the party's name set in italics: "{unit} until {name}". */
  function withName(text, name) {
    var parts = text.split("\u0000");
    return [parts[0], el("span", { class: "name", text: name, attrs: { dir: "auto" } }), parts[1] || ""];
  }

  function photo(n) {
    var img = el("img", { attrs: { src: "/img/hero/hero-" + n + ".jpg", alt: "", decoding: "async" } });
    img.addEventListener("error", function () { img.remove(); });
    return img;
  }
  function myTicket(p) { return mine.filter(function (m) { return m.party_id === p.id && m.status !== "invalid"; })[0]; }
  function hrefFor(p) { var my = myTicket(p); return my ? my.link : "/signup.html?party=" + encodeURIComponent(p.id); }
  function whenLine(p) { return Sahra.when(p.starts_at, p.time_zone) + (p.from_price ? "  /  " + t("h_from", { amount: Sahra.amount(p.from_price) }) : ""); }

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

  // ------------------------------------------------------------------ hero

  /** The moon: a lit disc masked by a shade disc that slides away by `share` (0..1) of the way to full. */
  function moon(share) {
    function n(tag, attrs) { var x = document.createElementNS(NS, tag); Object.keys(attrs).forEach(function (k) { x.setAttribute(k, attrs[k]); }); return x; }
    var svg = n("svg", { viewBox: "0 0 100 100", class: "moon", "aria-hidden": "true" });
    // Fully lit once the shade has moved past the disc (two radii and a little).
    svg.style.setProperty("--dx", Math.round(share * 86) + "px"); // CSSOM: allowed under the page's style policy
    var id = "moon-cut-" + Math.random().toString(36).slice(2, 8);
    var mask = n("mask", { id: id });
    mask.appendChild(n("rect", { x: -20, y: -20, width: 140, height: 140, fill: "#fff" }));
    mask.appendChild(n("circle", { class: "shade", cx: 50, cy: 50, r: 41, fill: "#000" }));
    var defs = n("defs", {});
    defs.appendChild(mask);
    svg.appendChild(defs);
    svg.appendChild(n("circle", { cx: 50, cy: 50, r: 40, fill: "none", stroke: "currentColor", "stroke-opacity": 0.3, "stroke-width": 1 }));
    svg.appendChild(n("circle", { cx: 50, cy: 50, r: 40, fill: "currentColor", mask: "url(#" + id + ")" }));
    return svg;
  }

  function nextParty() {
    if (!parties || !parties.length) return null;
    var now = Date.now();
    var ahead = parties.filter(function (p) { return p.starts_at > now; }).sort(function (a, b) { return a.starts_at - b.starts_at; });
    return ahead[0] || parties[0];
  }

  function rise(node, i) { node.classList.add("rise"); node.style.setProperty("--i", String(i)); return node; }

  function hero() {
    var p = nextParty();
    var main = el("div", { class: "hero-main" });
    var big, line, share;
    if (!p) {
      big = el("span", { class: "num", text: "00" });
      line = el("p", { class: "hero-unit", text: failed || t("h_none") });
      share = 0.12;
    } else {
      var left = p.starts_at - Date.now();
      if (left <= 0) {
        big = el("span", { class: "word", text: t("h_now_word") });
        line = el("p", { class: "hero-unit" }, withName(t("h_now_line", { name: "\u0000" }), p.name));
        share = 1;
      } else {
        var days = left >= DAY;
        var n = days ? Math.ceil(left / DAY) : Math.max(1, Math.ceil(left / HOUR));
        big = el("span", { class: "num", text: pad(n) });
        line = el("p", { class: "hero-unit" }, withName(t("h_until", { unit: unit(n, days ? "days" : "hours"), name: "\u0000" }), p.name));
        share = Math.max(0.12, Math.min(1, 1 - left / MOON_WINDOW));
      }
    }
    main.appendChild(rise(el("p", { class: "label", text: t("h_next") }), 0));
    main.appendChild(rise(el("div", { class: "hero-num" }, big, moon(share)), 1));
    main.appendChild(rise(line, 2));
    if (p) {
      main.appendChild(rise(el("p", { class: "hero-when", text: whenLine(p) }), 3));
      main.appendChild(rise(el("div", { class: "hero-actions" },
        el("a", { class: "btn primary", text: myTicket(p) ? t("h_view_ticket") : t("h_request"), attrs: { href: hrefFor(p) } }),
        el("a", { class: "btn", text: t("h_all"), attrs: { href: "#parties" } })), 4));
    }

    var list = parties || [];
    var open = list.filter(function (x) { return x.state === "open"; }).length;
    var prices = list.map(function (x) { return x.from_price; }).filter(function (v) { return typeof v === "number"; });
    var low = prices.length ? Math.min.apply(null, prices) : null;
    function metric(value, label) { return el("div", null, el("dt", { text: label }), el("dd", { text: value })); }
    var side = el("div", { class: "hero-side" },
      rise(el("p", { class: "hero-sub", text: t("h_sub") }), 5),
      rise(el("dl", { class: "hero-metrics" },
        metric(failed ? "-" : pad(list.length), t("h_m_upcoming")),
        metric(failed ? "-" : pad(open), t("h_m_open")),
        metric(low === null ? "-" : Sahra.money(low), t("h_m_from"))), 6));

    return el("section", { class: "hero" + (revealed ? " settled" : "") },
      el("div", { class: "hero-tex", attrs: { "aria-hidden": "true" } }, PHOTOS.map(function (k) { return el("div", { class: "ph" }, photo(k)); })),
      el("div", { class: "hero-in" }, main, side));
  }

  // ------------------------------------------------------------- programme

  function row(href, day, mon, name, meta, state) {
    return el("li", null, el("a", { class: "show", attrs: { href: href } },
      el("span", { class: "d" }, el("span", { class: "dd", text: day }), el("span", { class: "mm", text: mon })),
      el("span", { class: "what" }, el("span", { class: "name", text: name, attrs: { dir: "auto" } }), el("span", { class: "meta", text: meta })),
      el("span", { class: "state" }, state),
      el("span", { class: "go", text: "→", attrs: { "aria-hidden": "true" } })));
  }
  function show(p) {
    var my = myTicket(p);
    return row(hrefFor(p), datePart(p.starts_at, p.time_zone, { day: "2-digit" }), datePart(p.starts_at, p.time_zone, { month: "short" }),
      p.name, whenLine(p), my ? myPill(my.status) : statePill(p));
  }

  function partiesSection() {
    var out = [el("div", { class: "section-head", attrs: { id: "parties" } },
      el("h2", { text: t("h_upcoming") }),
      parties && parties.length ? el("span", { class: "label", text: t("h_count", { n: parties.length }) }) : null)];
    if (failed) out.push(el("p", { class: "notice no", text: failed }));
    else if (!loaded) out.push(el("p", { class: "empty", text: t("loading") }));
    else if (!parties.length) out.push(el("p", { class: "empty", text: t("h_none") }));
    else out.push(el("ol", { class: "programme" }, parties.map(show)));
    return out;
  }

  function mineSection() {
    var shown = mine.filter(function (m) { return m.status !== "invalid"; });
    if (!shown.length) return [];
    return [el("div", { class: "section-head", attrs: { id: "mine" } }, el("h2", { text: t("h_your_tickets") })),
      el("ol", { class: "programme" }, shown.slice(0, 6).map(function (m) {
        return row(m.link, m.starts_at ? datePart(m.starts_at, m.time_zone, { day: "2-digit" }) : "-",
          m.starts_at ? datePart(m.starts_at, m.time_zone, { month: "short" }) : "", m.party_name,
          m.starts_at ? Sahra.when(m.starts_at, m.time_zone) : "", myPill(m.status));
      }))];
  }

  function how() {
    return el("section", { class: "how", attrs: { id: "how" } },
      el("div", { class: "section-head" }, el("h2", { text: t("h_how_title") })),
      el("p", { class: "how-lede", text: t("h_about_text") }),
      el("ol", { class: "steps" }, [1, 2, 3].map(function (n) {
        return el("li", null, el("span", { class: "n", text: String(n) }),
          el("div", null, el("h3", { text: t("h_step" + n + "_t") }), el("p", { text: t("h_step" + n + "_p") })));
      })),
      el("div", { class: "host" },
        el("div", null, el("h3", { text: t("h_host_t") }), el("p", { class: "muted", text: t("h_host_p") })),
        el("a", { class: "btn", text: t("sign_in"), attrs: { href: "/signin.html" } })));
  }

  function render() {
    document.title = "Sahra";
    Sahra.clear(heroBox);
    // Until the numbers arrive the hero is an empty charcoal block of the same size: no fake or placeholder figures.
    heroBox.appendChild(loaded ? hero() : el("section", { class: "hero" }, el("div", { class: "hero-in" })));
    if (loaded) revealed = true;
    Sahra.clear(app);
    mineSection().concat(partiesSection(), [how()]).forEach(function (n) { app.appendChild(n); });
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
    loaded = true;
    render();
  }

  Sahra.boot({ render: render });
  load();
})();
