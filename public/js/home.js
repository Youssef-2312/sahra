// Home page (owner decisions): a full-width hero (the party photos behind the
// heading, "Discover parties" and "How it works"), the upcoming parties as a
// wrapping grid of cards (artwork, date and time, name, price, availability,
// action), ticket steps and preparation tips, party photography and the footer.
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
  var filter = "all";
  var experienceChoice = 0;
  var stopCollage = function () {};
  // Render after boot so its legacy section observer does not animate this page.
  var ready = false;
  var partyFind = "";     // the party search (shown once there are several parties)     // the chips above the parties (this page only, not remembered)

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

  // Each photo exists once. Offscreen tiles move to the end instead of being cloned.
  // Story photos (17, 19, 24) and footer photos (18, 20, 22) are reserved.
  var HERO = [1, 8, 14, 3, 10, 16, 6, 5, 13, 2, 15, 9, 4, 11, 12, 7];
  function collage() {
    var lanes = [HERO.slice(0,8), HERO.slice(8)];
    return el("div", { class:"hero-bg", attrs:{"aria-hidden":"true",dir:"ltr"} },
      el("div", { class:"tilt" }, lanes.map(function (items) {
        return el("div", { class:"lane" }, items.map(function(n){var img=photo(n,true);img.setAttribute("fetchpriority","low");return el("div",{class:"ph"},img);}));
      })));
  }
  function animateCollage(background) {
    var lanes=Array.from(background.querySelectorAll(".lane")), offsets=[0,120,240], steps=[], frame=0, last=0, visible=false, disposed=false;
    function reduced(){return window.SahraAppearance?SahraAppearance.reducedMotion():matchMedia("(prefers-reduced-motion: reduce)").matches;}
    function measure(){steps=lanes.map(function(lane){return lane.firstElementChild.offsetWidth+8;});}
    function tick(time){
      frame=0;if(disposed||!visible||document.hidden||reduced())return;
      var dt=last?Math.min(time-last,64)/1000:0;last=time;
      lanes.forEach(function(lane,i){var step=steps[i];if(!step)return;offsets[i]+=[15,12,17][i]*dt;while(offsets[i]>=step){lane.appendChild(lane.firstElementChild);offsets[i]-=step;}lane.style.transform="translateX("+(-offsets[i])+"px)";});
      frame=requestAnimationFrame(tick);
    }
    function sync(){if(frame)cancelAnimationFrame(frame);frame=0;last=0;if(!disposed&&visible&&!document.hidden&&!reduced()){measure();frame=requestAnimationFrame(tick);}}
    var observer=new IntersectionObserver(function(entries){visible=entries[0].isIntersecting;sync();},{rootMargin:"100px"});observer.observe(background);
    document.addEventListener("visibilitychange",sync);document.addEventListener("sahra:appearance",sync);window.addEventListener("resize",sync);
    return function(){disposed=true;if(frame)cancelAnimationFrame(frame);observer.disconnect();document.removeEventListener("visibilitychange",sync);document.removeEventListener("sahra:appearance",sync);window.removeEventListener("resize",sync);};
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
        Sahra.ageRating(p.age_rating) ? el("span", {class:"age-rating",text:Sahra.ageRating(p.age_rating),attrs:{"aria-label":t("age_accessible",{rating:Sahra.ageRating(p.age_rating)}),dir:p.age_rating.indexOf("minimum:") === 0 ? "ltr" : "auto"}}) : null,
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
        var shown = parties.filter(FILTERS[filter]).filter(function (p) { return Sahra.matches(partyFind, [p.name, p.id]); });
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
      var search = Sahra.findBox({ value: partyFind, placeholder: t("h_find_ph"), onChange: function (v) { partyFind = v; fill(); } });
      search.id = "party-search";
      list.push(search);
      if (new URLSearchParams(location.search).get("search") === "1") requestAnimationFrame(function () {
        var input = document.querySelector("#party-search input");
        if (input && !document.activeElement.matches("input,textarea,select")) input.focus();
      });
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

  // An interactive guide to real ticket configurations, not an invented live event.
  function ticketExperience() {
    var buttons = [], panel = el("div", { class: "home-ticket-stage", attrs: { id: "ticket-experience-panel", role: "tabpanel", tabindex: "0" } });
    var modes = ["solo", "individual", "shared"];
    function draw() {
      var mode = modes[experienceChoice];
      buttons.forEach(function (button, i) { button.setAttribute("aria-selected", String(i === experienceChoice)); button.tabIndex = i === experienceChoice ? 0 : -1; });
      panel.setAttribute("aria-labelledby", "ticket-choice-" + mode);
      var tickets = el("div", { class: "home-ticket-stack", attrs: { "aria-hidden": "true" } },
        el("img", { class: "home-ticket-fan", attrs: { src: "/img/sahra-ticket-fan.webp", alt: "", width: 1672, height: 941, loading: "lazy", decoding: "async" } }));
      panel.replaceChildren(el("div", { class: "home-stage-label" }, el("span", { class: "label-line", text: t("h_x_preview") }),
        el("span", { class: "pill", text: t("h_x_" + mode + "_tag") })), tickets,
        el("div", { class: "home-stage-note" }, el("h3", { text: t("h_x_" + mode + "_title") }), el("p", { text: t("h_x_" + mode + "_p") })));

    }
    var tabs = el("div", { class: "home-ticket-tabs", attrs: { role: "tablist", "aria-label": t("h_x_choose"), "aria-orientation": "vertical" } });
    modes.forEach(function (mode, i) {
      var button = el("button", { class: "home-ticket-tab", attrs: { type: "button", role: "tab", id: "ticket-choice-" + mode, "aria-controls": "ticket-experience-panel" } },
        el("span", null, el("strong", { text: t("h_x_" + mode + "_label") }), el("span", { text: t("h_x_" + mode + "_short") })));
      button.addEventListener("click", function () { experienceChoice = i; draw(); });
      button.addEventListener("keydown", function (e) {
        var next = e.key === "ArrowDown" ? (i + 1) % 3 : e.key === "ArrowUp" ? (i + 2) % 3 : e.key === "Home" ? 0 : e.key === "End" ? 2 : null;
        if (next === null) return; e.preventDefault(); experienceChoice = next; draw(); buttons[next].focus();
      });
      buttons.push(button); tabs.appendChild(button);
    });
    draw();
    return el("section", { class: "home-experience" },
      el("div", { class: "home-experience-copy" }, el("p", { class: "label-line", text: t("h_x_label") }),
        el("h2", { text: t("h_x_title") }), el("p", { class: "lede", text: t("h_x_p") }), tabs,
        el("a", { class: "why-more", attrs: { href: "#parties" }, text: t("h_x_action") })), panel);
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
        [17, 19, 24].map(function (n) { return el("div", null, photo(n, false)); })));
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

  // Guest-focused ticket steps, preparation cards and questions.
  function how() {
    return el("section", { class: "how", attrs: { id: "how" } },
      el("div", { class: "section-head" }, el("h2", { text: t("h_how_title") })),
      el("ol", { class: "mk-ticket-steps" }, [1, 2, 3, 4].map(function (n) {
        return el("li", null, el("span", { class: "mk-step-mark", text: String(n), attrs: { "aria-hidden": "true" } }),
          el("h3", { text: t("mk_step" + n + "_t") }), el("p", { text: t("mk_step" + n + "_p") }));
      })),
      guide("ready"),
      faq());
  }

  function hostInvitation() {
    return el("section", { class: "mk-host-band" },
      el("div", null, el("p", { class: "mk-badge", text: t("mk_host_badge") }),
        el("h2", { text: t("mk_host_title") }), el("p", { text: t("mk_host_p") })),
      el("a", { class: "btn primary", text: t("mk_host_action"), attrs: { href: "/contact.html" } }));
  }

  function render() {
    if (!ready) return;
    Sahra.clear(app);
    Sahra.title(null);
    stopCollage();
    Sahra.clear(heroBox).appendChild(hero());
    stopCollage=animateCollage(heroBox.querySelector(".hero-bg"));
    var m = mineSection();
    if (m) m.forEach(function (n) { app.appendChild(n); });
    app.appendChild(el("div", { class: "parties-section" }, partiesSection()));
    app.appendChild(why());
    app.appendChild(ticketExperience());
    app.appendChild(story());
    app.appendChild(how());
    app.appendChild(hostInvitation());
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
  window.addEventListener("pagehide",function(){stopCollage();});
  window.addEventListener("pageshow",function(e){if(e.persisted){stopCollage=animateCollage(heroBox.querySelector(".hero-bg"));}});
  ready = true;
  render();
  load();
})();
