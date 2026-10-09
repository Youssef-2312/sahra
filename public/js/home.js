// Home page (owner decisions): a full-width hero (the party photos behind the
// heading, "Discover parties" and "How it works"), the upcoming parties as a
// wrapping grid of cards (artwork, date and time, name, price, availability,
// action), ticket steps and preparation tips, party photography, hosting
// guidance, the organiser sign-in row and the footer.
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
  var filter = "all";     // the chips above the parties (this page only, not remembered)
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
    if (p.state === "cancelled") return el("span", { class: "pill no", text: t("h_state_cancelled") });
    if (p.state === "full") return el("span", { class: "pill no", text: t("h_state_full") });
    if (p.state === "not_open_yet") return el("span", { class: "pill", text: p.opens_at ? t("h_state_not_open_yet", { rel: Sahra.rel(p.opens_at) }) : t("h_state_soon") });
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

  // A party card (owner spec): the party's own artwork on top (16:9, cropped to
  // fill) with the date on it, then date and time, name (three lines at most
  // here; the full name is on the party's page), price, availability, action.
  // No artwork (or it fails to load): a poster made of the date itself, never a
  // borrowed photo or an empty frame (owner: the page looked bland).
  function dateBadge(p, big) {
    return el("span", { class: "date-badge" + (big ? " big" : ""), attrs: { "aria-hidden": "true" } },
      el("span", { class: "d", text: datePart(p.starts_at, p.time_zone, { day: "numeric" }) }),
      el("span", { class: "m", text: datePart(p.starts_at, p.time_zone, { month: "short" }) }));
  }
  function poster(p) {
    return el("div", { class: "cover poster", attrs: { "aria-hidden": "true" } },
      dateBadge(p, true),
      el("span", { class: "wd", text: datePart(p.starts_at, p.time_zone, { weekday: "long" }) }),
      el("img", { class: "mark", attrs: { src: "/img/sahra-mark.svg", alt: "" } }));
  }
  function cover(p) {
    var f = (p.flyers || [])[0];
    var few = p.state === "open" && p.places_left > 0 && p.places_left <= 20
      ? el("span", { class: "few", text: t("left_n", { n: p.places_left }) }) : null;
    if (!f) { var po = poster(p); if (few) po.appendChild(few); return po; }
    var box = el("div", { class: "cover" });
    var img = el("img", { attrs: { src: f.url, alt: t("h_flyer_alt", { name: p.name }), loading: "lazy", decoding: "async" } });
    img.addEventListener("error", function () { var po = poster(p); if (few) po.appendChild(few); box.replaceWith(po); });
    box.append(img, dateBadge(p, false));
    if (few) box.appendChild(few);
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
    var cls = p.state === "open" ? "yes" : p.state === "full" || p.state === "cancelled" ? "no" : "off";
    var text = p.state === "cancelled" ? t("h_state_cancelled") : p.state === "full" ? t("h_state_full")
      : p.state === "not_open_yet" ? (p.opens_at ? t("h_state_not_open_yet", { rel: Sahra.rel(p.opens_at) }) : t("h_state_soon"))
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
    var art = cover(p);
    return el("a", { class: "party-card", attrs: { href: href } },
      art,
      el("div", { class: "info" },
        el("span", { class: "when", text: Sahra.when(p.starts_at, p.time_zone) }),
        el("span", { class: "name", text: p.name, attrs: { dir: "auto", title: p.name } }),
        price ? el("span", { class: "price-line", text: price }) : null,
        availability(p, my),
        el("span", { class: "go", text: action })));
  }

  // Parties as one wrapping grid (owner): 3 columns on wide screens, 2 where
  // they fit, 1 on phones. Nothing to page through. Chips above it narrow the
  // list (only the ones that match something are shown).
  var FILTERS = {
    all: function () { return true; },
    week: function (p) { return p.starts_at - Date.now() < 7 * 86400000; },
    free: function (p) { return p.from_price === 0; },
    open: function (p) { return p.state === "open"; },
  };
  function partiesSection() {
    var head = el("div", { class: "section-head", attrs: { id: "parties" } }, el("h2", { text: t("h_upcoming") }));
    var list = [head];
    if (failed) list.push(el("p", { class: "notice no", text: failed }));
    else if (!parties) list.push(el("p", { class: "muted", text: t("loading") }));
    else if (!parties.length) list.push(el("div", { class: "empty-note" },
      el("p", { class: "lead", text: t("h_none_t") }), el("p", { class: "muted", text: t("h_none_p") })));
    else {
      var grid = el("div", { class: "parties-grid" });
      var count = el("span", { class: "count", attrs: { "aria-live": "polite" } });
      var chips = el("div", { class: "chips", attrs: { role: "group", "aria-label": t("h_filter_label") } });
      var keys = Object.keys(FILTERS).filter(function (k) { return k === "all" || parties.some(FILTERS[k]); });
      if (!keys.some(function (k) { return k === filter; })) filter = "all";
      var fill = function () {
        var shown = parties.filter(FILTERS[filter]);
        Sahra.clear(grid);
        if (shown.length) shown.forEach(function (p) { grid.appendChild(card(p)); });
        else grid.appendChild(el("p", { class: "muted none", text: t("h_filter_none") }));
        count.textContent = shown.length === 1 ? t("h_count_one") : t("h_count", { n: shown.length });
        chips.querySelectorAll("button").forEach(function (b) { b.setAttribute("aria-pressed", b.dataset.f === filter ? "true" : "false"); });
      };
      if (keys.length > 1) keys.forEach(function (k) {
        var b = el("button", { class: "chip", text: t("h_filter_" + k), attrs: { type: "button" } });
        b.dataset.f = k;
        b.addEventListener("click", function () { filter = k; fill(); });
        chips.appendChild(b);
      });
      head.appendChild(el("div", { class: "head-tools" }, keys.length > 1 ? chips : null, count));
      fill();
      list.push(grid);
    }
    return list;
  }

  // Why Sahra: four true facts (the About page's), in a band of tiles.
  function why() {
    return el("section", { class: "why" },
      el("div", { class: "why-head" }, el("p", { class: "label-line", text: t("h_why_label") }), el("h2", { text: t("h_why_title") })),
      el("div", { class: "why-tiles" }, [1, 2, 3, 4].map(function (n) {
        return el("div", { class: "why-tile" }, el("strong", { text: t("h_fact" + n + "_t") }), el("span", { text: t("h_fact" + n + "_p") }));
      })),
      el("a", { class: "why-more", text: t("h_why_more"), attrs: { href: "/about" } }));
  }

  // Existing owner-supplied photos are decorative, never used as party artwork.
  function story() {
    return el("section", { class: "home-story" },
      el("div", { class: "home-story-copy" },
        el("p", { class: "label-line", text: t("h_story_label") }),
        el("h2", { text: t("h_story_title") }),
        el("p", { class: "lede", text: t("h_story_p") }),
        el("a", { class: "btn", text: t("h_story_link"), attrs: { href: "#parties" } })),
      el("div", { class: "home-photos", attrs: { "aria-hidden": "true" } },
        [13, 8, 3].map(function (n) { return el("div", null, photo(n, false)); })));
  }

  function guide(kind) {
    var host = kind === "hosts";
    return el("section", { class: "home-guide home-guide-" + kind },
      el("div", { class: "home-guide-head" },
        el("p", { class: "label-line", text: t(host ? "h_host_label" : "h_ready_label") }),
        el("h2", { text: t("h_" + kind + "_title") }),
        el("p", { class: "lede", text: t("h_" + kind + "_p") }),
        host ? el("a", { class: "why-more", text: t("h_hosts_link"), attrs: { href: "/about" } }) : null),
      el("ol", { class: "home-guide-list" }, [1, 2, 3].map(function (n) {
        return el("li", null,
          el("span", { class: "home-guide-number", text: "0" + n, attrs: { "aria-hidden": "true" } }),
          el("div", null, el("h3", { text: t("h_" + kind + n + "_t") }),
            el("p", { text: t("h_" + kind + n + "_p") })));
      })));
  }

  function mineSection() {
    var shown = mine.filter(function (m) { return m.status !== "invalid"; });
    if (!shown.length) return null;
    return [el("div", { class: "section-head", attrs: { id: "mine" } }, el("h2", { text: t("h_your_tickets") }),
      el("a", { class: "why-more", text: t("find_tickets"), attrs: { href: "/find" } })),
      el("div", { class: "mine" }, shown.slice(0, 6).map(function (m) {
        return el("a", { attrs: { href: m.link } },
          el("span", null, el("strong", { text: m.party_name, attrs: { dir: "auto" } }), el("br"),
            el("span", { class: "small muted", text: m.starts_at ? Sahra.when(m.starts_at, m.time_zone) : "" })),
          myPill(m.status));
      }))];
  }

  // Four short questions (owner spec), as native details/summary: keyboard and screen readers work as is.
  function faq() {
    return el("div", { class: "faq" },
      el("h2", { text: t("h_faq_title") }),
      [1, 2, 3, 4].map(function (n) {
        return el("details", null, el("summary", { text: t("h_faq" + n + "_q") }), el("p", { text: t("h_faq" + n + "_a") }));
      }));
  }

  // How tickets work: plain text in three columns, the questions, then the organiser sign-in row.
  function how() {
    return el("section", { class: "how", attrs: { id: "how" } },
      el("div", { class: "section-head" }, el("h2", { text: t("h_how_title") })),
      el("div", { class: "steps" }, [1, 2, 3].map(function (n) {
        return el("div", { class: "step step-card" },
          el("span", { class: "num", text: "0" + n }),
          el("h3", { text: t("h_step" + n + "_t") }),
          el("p", { text: t("h_step" + n + "_p") }));
      })),
      guide("ready"),
      faq(),
      guide("hosts"),
      // For organisers: a panel over one of the party photos (darkened, flat; no gradient).
      el("div", { class: "host host-panel" },
        photo(5, false),
        el("div", { class: "shade", attrs: { "aria-hidden": "true" } }),
        el("div", { class: "host-copy" },
          el("p", { class: "label-line", text: t("h_host_label") }),
          el("h3", { text: t("h_host_t") }), el("p", { text: t("h_host_p") })),
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
    app.appendChild(el("div", { class: "parties-section" }, partiesSection()));
    app.appendChild(why());
    app.appendChild(story());
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
