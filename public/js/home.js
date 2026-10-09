// Home page (owner decisions): a full-width hero (the party photos behind the
// heading, "Discover parties" and "How it works"), the upcoming parties as a
// sideways row of cards (flyers on the start side, then date and time, name,
// price, availability, action; arrows only when the row overflows), "How
// tickets work" in three plain columns, the organiser sign-in row, the footer.
// Sign-in for organisers and staff sits at the top right. A card shows this
// browser's own ticket for that party when it remembers one (brainstorm idea 4):
// the links saved by the sign-up and ticket pages (localStorage sahra_tickets),
// checked in one call. Prices are only ever the real ones: "EGP 350" for one
// price, "From EGP 350" for several, nothing when unknown.
"use strict";
(function () {
  var t = Sahra.t, el = Sahra.el;
  var app = document.getElementById("app");
  var parties = null, failed = null;
  var mine = [];          // [{ link, status, party_id, party_name, starts_at, time_zone }]
  var heroBox = document.getElementById("hero");
  // The owner's sixteen photos (6 and 7 look alike when blurred, so they are kept apart).
  var HERO = [1, 13, 8, 2, 14, 9, 3, 15, 10, 4, 16, 11, 6, 12, 5, 7];

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

  // The moving collage (owner): every photo the same size, edge to edge, in rows
  // tilted on a diagonal; the whole sheet slides along the diagonal as one, so
  // the arrangement never changes and a photo never touches a copy of itself.
  // Row r starts step() photos further along,
  // and every other row is shifted half a photo. With 12 photos a full
  // screen still shows each a few times; more photos, fewer repeats.
  var LANES = 7;    // enough tilted rows to cover the corners of a wide screen
  // Row offsets that looked best for 16 photos (measured: no photo twice on screen at 1440 px with 6, at 390 px with 10).
  function step() { return window.matchMedia && window.matchMedia("(min-width: 900px)").matches ? 6 : 10; }
  function collage() {
    var lanes = [];
    for (var r = 0; r < LANES; r++) {
      var k = (r * step()) % HERO.length;
      var order = HERO.slice(k).concat(HERO.slice(0, k));
      // Three copies: the row moves by exactly one copy, so the screen is always covered and the loop has no seam.
      var tiles = order.concat(order, order).map(function (n, i) { return el("div", { class: "ph" }, photo(n, i < HERO.length * 2)); });
      lanes.push(el("div", { class: "lane" }, tiles));
    }
    // Decoration only: always laid out left to right, so Arabic gets the same no-repeat arrangement.
    return el("div", { class: "hero-bg", attrs: { "aria-hidden": "true", dir: "ltr" } }, el("div", { class: "tilt" }, lanes));
  }

  function hero() {
    var shown = mine.filter(function (m) { return m.status !== "invalid"; });
    return el("section", { class: "hero" },
      collage(),
      el("div", { class: "copy" },
        el("h1", null, heading(t("h_title_a"), t("h_title_em"), t("h_title_b"))),
        el("p", { text: t("h_sub") }),
        el("div", { class: "hero-actions" },
          el("a", { class: "btn primary", text: t("h_discover"), attrs: { href: "#parties" } }),
          shown.length
            ? el("a", { class: "btn", text: t("h_your_tickets"), attrs: { href: "#mine" } })
            : el("a", { class: "btn", text: t("h_how"), attrs: { href: "#how" } }))));
  }

  // A party card (owner's reference: an events row with the flyer and the details
  // beside it): the party's flyers on the start side as a small grid (one large,
  // up to two small), the details on the end side, aligned to the start. A party
  // without flyers shows its date on a plain tile, never someone else's photos.
  function flyers(p) {
    var list = (p.flyers || []).slice(0, 3);
    var box = el("div", { class: "flyers n" + Math.max(1, list.length) });
    if (!list.length) {
      box.classList.add("none");
      box.appendChild(el("div", { class: "date-tile" },
        el("span", { class: "day", text: datePart(p.starts_at, p.time_zone, { day: "numeric" }) }),
        el("span", { class: "mon", text: datePart(p.starts_at, p.time_zone, { month: "short" }) })));
      return box;
    }
    list.forEach(function (f, i) {
      var img = el("img", { attrs: { src: f.url, alt: i === 0 ? t("h_flyer_alt", { name: p.name }) : "", loading: "lazy", decoding: "async" } });
      img.addEventListener("error", function () { img.remove(); });
      box.appendChild(el("div", { class: "fl" }, img));
    });
    return box;
  }

  /** The real price only: "EGP 350" for one price, "From EGP 350" for several, nothing when unknown. */
  function priceText(p) {
    if (p.from_price === null || p.from_price === undefined) return null;
    if (p.from_price === 0 && p.price_count <= 1) return t("free");
    return p.price_count > 1 ? t("h_from", { amount: Sahra.amount(p.from_price) }) : Sahra.amount(p.from_price);
  }
  function availability(p, my) {
    if (my) return el("span", { class: "tags" }, myPill(my.status));
    var cls = p.state === "open" ? "yes" : p.state === "full" ? "no" : "off";
    var text = p.state === "full" ? t("h_state_full")
      : p.state === "not_open_yet" ? t("h_state_not_open_yet", { rel: Sahra.rel(p.opens_at) })
      : p.state === "closed" ? t("h_state_closed") : t("h_state_open");
    return el("span", { class: "status " + cls }, el("span", { class: "dot", attrs: { "aria-hidden": "true" } }), el("span", { text: text }));
  }

  // Date and time, name, price, availability, action (owner's order). The action
  // sits at the bottom of the card without a fixed height, so long names wrap.
  function card(p) {
    var my = mine.filter(function (m) { return m.party_id === p.id && m.status !== "invalid"; })[0];
    var href = my ? my.link : "/signup.html?party=" + encodeURIComponent(p.id);
    var price = priceText(p);
    var action = my ? t("h_view_ticket") : p.state === "open" ? t("h_request") : t("h_details");
    return el("a", { class: "party-card", attrs: { href: href } },
      flyers(p),
      el("div", { class: "info" },
        el("span", { class: "when", text: Sahra.when(p.starts_at, p.time_zone) }),
        el("span", { class: "name", text: p.name, attrs: { dir: "auto" } }),
        price ? el("span", { class: "price-line", text: price }) : null,
        availability(p, my),
        el("span", { class: "go", text: action })));
  }

  function chevron(next) {
    var ns = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    var path = document.createElementNS(ns, "path");
    path.setAttribute("d", next ? "M9 5l7 7-7 7" : "M15 5l-7 7 7 7");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "2");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.appendChild(path);
    return svg;
  }

  // Parties as pages of a fixed grid (owner): 3 columns x 3 rows on desktops
  // (party 1 2 3 / 4 5 6 / 7 8 9), 2 x 3 on tablets, 1 x 3 on phones. The arrows
  // turn the page; they appear only when there is more than one page.
  var page = 0;
  var WIDE = window.matchMedia ? window.matchMedia("(min-width: 900px)") : null;
  var MID = window.matchMedia ? window.matchMedia("(min-width: 600px)") : null;
  function perPage() { return 3 * (WIDE && WIDE.matches ? 3 : MID && MID.matches ? 2 : 1); }
  var sectionBox = null;
  function redrawParties() {
    if (!sectionBox || !sectionBox.parentNode) return;
    var fresh = el("div", { class: "parties-section" }, partiesSection());
    sectionBox.parentNode.replaceChild(fresh, sectionBox);
    sectionBox = fresh;
  }
  [WIDE, MID].forEach(function (mq) {
    if (!mq) return;
    var on = function () { redrawParties(); };
    if (mq.addEventListener) mq.addEventListener("change", on); else if (mq.addListener) mq.addListener(on);
  });

  function partiesSection() {
    var per = perPage();
    var pages = parties && parties.length ? Math.ceil(parties.length / per) : 1;
    page = Math.min(page, pages - 1);
    function turn(d) { page = Math.max(0, Math.min(pages - 1, page + d)); redrawParties(); }
    var nav = pages > 1 ? el("div", { class: "rail-nav" },
      el("button", { class: "round", attrs: { type: "button", "aria-label": t("h_prev"), disabled: page === 0 }, on: { click: function () { turn(-1); } } }, chevron(false)),
      el("span", { class: "page-count", text: t("h_page", { n: page + 1, total: pages }), attrs: { "aria-live": "polite" } }),
      el("button", { class: "round", attrs: { type: "button", "aria-label": t("h_next"), disabled: page === pages - 1 }, on: { click: function () { turn(1); } } }, chevron(true))) : null;
    var list = [el("div", { class: "section-head", attrs: { id: "parties" } }, el("h2", { text: t("h_upcoming") }), nav)];
    if (failed) list.push(el("p", { class: "notice no", text: failed }));
    else if (!parties) list.push(el("p", { class: "muted", text: t("loading") }));
    else if (!parties.length) list.push(el("p", { class: "empty", text: t("h_none") }));
    else list.push(el("div", { class: "parties-grid" }, parties.slice(page * per, page * per + per).map(card)));
    return list;
  }

  function mineSection() {
    var shown = mine.filter(function (m) { return m.status !== "invalid"; });
    if (!shown.length) return null;
    return [el("div", { class: "section-head", attrs: { id: "mine" } }, el("h2", { text: t("h_your_tickets") })),
      el("div", { class: "mine" }, shown.slice(0, 6).map(function (m) {
        return el("a", { attrs: { href: m.link } },
          el("span", null, el("strong", { text: m.party_name, attrs: { dir: "auto" } }), el("br"),
            el("span", { class: "small muted", text: m.starts_at ? Sahra.when(m.starts_at, m.time_zone) : "" })),
          myPill(m.status));
      }))];
  }

  // How tickets work: plain text in three columns, then the organiser sign-in row.
  function how() {
    return el("section", { class: "how", attrs: { id: "how" } },
      el("div", { class: "section-head" }, el("h2", { text: t("h_how_title") })),
      el("div", { class: "steps" }, [1, 2, 3].map(function (n) {
        return el("div", { class: "step" },
          el("span", { class: "num", text: "0" + n }),
          el("h3", { text: t("h_step" + n + "_t") }),
          el("p", { text: t("h_step" + n + "_p") }));
      })),
      el("div", { class: "host" },
        el("div", null, el("h3", { text: t("h_host_t") }), el("p", { class: "muted", text: t("h_host_p") })),
        el("div", { class: "host-actions" },
          el("a", { class: "btn primary", text: t("h_contact"), attrs: { href: "/contact.html" } }),
          el("a", { class: "btn", text: t("sign_in"), attrs: { href: "/signin.html" } }))));
  }

  function render() {
    Sahra.clear(app);
    Sahra.title(null);
    Sahra.clear(heroBox).appendChild(hero());
    var m = mineSection();
    if (m) m.forEach(function (n) { app.appendChild(n); });
    sectionBox = el("div", { class: "parties-section" }, partiesSection());
    app.appendChild(sectionBox);
    app.appendChild(how());
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
