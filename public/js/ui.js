// Shared helpers for the Phase 5 pages (load after i18n.js). Plain browser
// JavaScript, no libraries. Exposes one global: Sahra.
//
//   Sahra.t(key, vars)          wording in the current language (falls back to English)
//   Sahra.el(tag, props, ...)   build an element; props: class, text, attrs, on, hidden
//   Sahra.api.get/post(path)    fetch JSON; { status, body, ok }; network errors -> status 0
//   Sahra.money(n)              "EGP 250" / "250 ج.م."; Sahra.when(ms, tz), Sahra.rel(ms)
//   Sahra.boot({ render, me })  top bar, language switch and site footer; render() runs again on a switch
//   Sahra.title(page)           the browser tab: "Page | Sahra"
//
// Top bar (owner decision): "Sahra" (home) at the start; the language switch and
// "Sign in" (or the signed-in person, linking to their dashboard) at the end,
// top-right in English. Footer (brainstorm idea 28): Privacy and Terms, copyright,
// and in the corner "Built by Nova" with Nova's logo and an Instagram icon next
// to it (Nova's Instagram; Sahra has none). Both links open a new tab; nothing
// loads from those sites until tapped.
"use strict";
var Sahra = (function () {
  var KEY = "sahra_lang";
  // Which kind of staff session this browser last confirmed ("party" or
  // "platform"; nothing else is kept). Public pages ask the server who is signed
  // in only when it is set, so guests never make that request; the server's
  // answer decides, and a refused session clears it.
  var SESSION_KEY = "sahra_session";
  var NOVA_URL = "https://bynova.vercel.app/";
  var NOVA_INSTAGRAM = "https://www.instagram.com/novadev.co/";
  // Nova's logo: a copy of Nova's favicon (bynova.vercel.app) kept in the project (nothing loads from Nova at run time).
  var NOVA_LOGO = "/img/nova-logo.svg";
  var csrf = null;
  var renderFn = null;

  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) {} },
  };

  function lang() { return store.get(KEY) === "ar" ? "ar" : "en"; }
  // Latin digits in Arabic too: prices, times and codes stay easy to compare.
  function locale() { return lang() === "ar" ? "ar-EG-u-nu-latn" : "en-GB"; }

  function t(key, vars) {
    var own = SahraText[lang()] || {};
    // An empty string is a real translation (a word order that needs no tail), not a gap.
    var s = typeof own[key] === "string" ? own[key] : typeof SahraText.en[key] === "string" ? SahraText.en[key] : key;
    if (vars) s = s.replace(/\{([a-z_]+)\}/g, function (m, k) { return k in vars ? String(vars[k]) : m; });
    return s;
  }

  function el(tag, props) {
    var e = document.createElement(tag);
    var p = props || {};
    if (p.class) e.className = p.class;
    if (p.text !== undefined && p.text !== null) e.textContent = String(p.text);
    if (p.hidden) e.hidden = true;
    if (p.attrs) Object.keys(p.attrs).forEach(function (k) { if (p.attrs[k] !== null && p.attrs[k] !== undefined && p.attrs[k] !== false) e.setAttribute(k, p.attrs[k] === true ? "" : p.attrs[k]); });
    if (p.on) Object.keys(p.on).forEach(function (k) { e.addEventListener(k, p.on[k]); });
    for (var i = 2; i < arguments.length; i++) add(e, arguments[i]);
    return e;
  }
  function add(parent, child) {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) { child.forEach(function (c) { add(parent, c); }); return; }
    parent.appendChild(typeof child === "string" || typeof child === "number" ? document.createTextNode(String(child)) : child);
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }

  async function call(method, path, body, headers) {
    var h = Object.assign({}, headers || {});
    var init = { method: method, credentials: "same-origin", headers: h };
    if (body instanceof FormData) init.body = body;
    else if (body !== undefined) { h["content-type"] = "application/json"; init.body = JSON.stringify(body); }
    // A page may pass its own token (the My parties session has its own); otherwise the party session's.
    if (method !== "GET" && csrf && !h["x-sahra-csrf"]) h["x-sahra-csrf"] = csrf;
    try {
      var r = await fetch(path, init);
      var j = await r.json().catch(function () { return {}; });
      return { status: r.status, ok: r.ok, body: j };
    } catch (e) {
      return { status: 0, ok: false, body: {} };
    }
  }
  var api = {
    get: function (path, headers) { return call("GET", path, undefined, headers); },
    post: function (path, body, headers) { return call("POST", path, body, headers); },
    /** Staff pages: who is signed in, and the CSRF token for later posts. null when signed out. */
    me: async function () {
      var r = await call("GET", "/api/me");
      if (!r.ok) { if (r.status === 401) store.del(SESSION_KEY); return null; }
      csrf = r.body.csrf;
      store.set(SESSION_KEY, "party");
      return r.body;
    },
  };

  /** Words for a failed request: the server's code when we know it, else a general line. */
  function errorText(r) {
    if (r.status === 0) return t("error_network");
    var code = r.body && r.body.error;
    if (code && (SahraText.en["e_" + code])) return t("e_" + code);
    return t("error_generic");
  }

  /** Whole Egyptian pounds, zero included: "EGP 1,250". */
  function amount(n) {
    try { return new Intl.NumberFormat(locale(), { style: "currency", currency: "EGP", maximumFractionDigits: 0 }).format(n || 0); }
    catch (e) { return "EGP " + (n || 0); }
  }
  /** A price: "Free" for zero. */
  function money(n) { return n ? amount(n) : t("free"); }

  /** A moment in the party's own time zone: "Sat 31 Oct, 22:00". */
  function when(ms, tz) {
    if (ms === null || ms === undefined) return "";
    var o = { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
    try { return new Intl.DateTimeFormat(locale(), Object.assign(o, tz ? { timeZone: tz } : {})).format(ms); }
    catch (e) { return new Date(ms).toLocaleString(); }
  }
  function time(ms, tz) {
    var o = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
    try { return new Intl.DateTimeFormat(locale(), Object.assign(o, tz ? { timeZone: tz } : {})).format(ms); }
    catch (e) { return new Date(ms).toLocaleTimeString(); }
  }

  /** "in 3 days", "in 5 hours", "in 10 minutes" (or "... ago"). */
  function rel(ms) {
    var d = ms - Date.now();
    var a = Math.abs(d);
    var f = new Intl.RelativeTimeFormat(locale(), { numeric: "auto" });
    if (a >= 86400000) return f.format(Math.round(d / 86400000), "day");
    if (a >= 3600000) return f.format(Math.round(d / 3600000), "hour");
    return f.format(Math.max(1, Math.round(a / 60000)) * Math.sign(d || 1), "minute");
  }

  /** The browser tab, Nova's way: "Page | Sahra"; the home page is "Sahra | Private party tickets". */
  /**
   * The one sign-in (brainstorm idea 27; owner: one sign-in for everyone who runs
   * parties): a photo panel and one "Continue with Google". The server finds what
   * the account may open (its party, My parties, the site-owner panel) and goes
   * there. Used by /signin and by /platform when signed out. `extra`: an error box.
   */
  function signinView(extra) {
    var img = el("img", { attrs: { src: "/img/hero/hero-3.jpg", alt: "", decoding: "async" } });
    img.addEventListener("error", function () { img.remove(); });
    return el("div", { class: "signin-wrap" },
      el("div", { class: "signin-panel" }, img, el("p", { class: "label-line", text: t("si_title") }), el("h1", { text: t("si_head") }), el("p", { text: t("si_text") })),
      el("div", null, extra || null,
        el("section", { class: "card" },
          el("h2", { text: t("si_one") }),
          el("p", { class: "muted", text: t("si_one_hint") }),
          el("form", { attrs: { method: "post", action: "/api/auth/google/start" } },
            el("button", { class: "btn primary", text: t("si_google"), attrs: { type: "submit" } }))),
        el("p", { class: "small muted", text: t("si_invite_only") }),
        el("p", { class: "small muted", text: t("si_door") })));
  }

  /**
   * A page that cannot go on (page not found, a ticket link that is not valid, a
   * party that does not exist, a sign-in that failed or is needed): the sign-in
   * page's layout, a photo panel with the message and the ways forward beside it.
   * o: { kicker, title, text, big?, actions: [[label, href, primary?]], extra?, hint?, code?, photo? }
   */
  function problem(o) {
    var img = el("img", { attrs: { src: o.photo || "/img/hero/hero-3.jpg", alt: "", decoding: "async" } });
    img.addEventListener("error", function () { img.remove(); });
    var panel = el("div", { class: "signin-panel notice-panel" }, img,
      el("p", { class: "label-line", text: o.kicker }),
      o.big ? el("p", { class: "notice-big", attrs: { "aria-hidden": "true" }, text: o.big }) : null,
      el("h1", { text: o.title }),
      el("p", { text: o.text }));
    var side = el("div", { class: "notice-side" }, o.extra || null, (o.actions || []).map(function (a) {
      return el("a", { class: "btn" + (a[2] ? " primary" : ""), attrs: { href: a[1] }, text: a[0] });
    }));
    if (o.code) side.appendChild(el("p", { class: "small muted notice-code", text: t("nt_code", { code: o.code }) }));
    if (o.hint) side.appendChild(el("p", { class: "small muted", text: o.hint }));
    return el("div", { class: "signin-wrap notice-wrap" }, panel, side);
  }

  function title(page) { document.title = page ? page + " | Sahra" : "Sahra | " + t("tab_home"); }

  function applyLang() {
    document.documentElement.lang = lang();
    document.documentElement.dir = lang() === "ar" ? "rtl" : "ltr";
  }

  /**
   * Top bar at the start of <body>; `render` runs now and after a language switch.
   * `me` (staff pages, from Sahra.api.me()) shows who is signed in; otherwise a
   * "Sign in" link to the staff sign-in page.
   */
  function boot(opts) {
    renderFn = (opts && opts.render) || null;
    var me = (opts && opts.me) || null;
    applyLang();
    var brand = el("a", { class: "brand", attrs: { href: "/" } }, el("img", { attrs: { src: "/img/sahra-mark.svg", alt: "", width: 28, height: 28 } }), "Sahra");
    var account = el("a", { class: "btn small-btn", attrs: { href: me ? (me.staff.role === "door" ? "/scan.html" : "/dashboard.html") : "/signin.html" } });
    var sw = el("button", { class: "lang-switch", attrs: { type: "button" } });
    var foot = el("footer", { class: "site-footer" });
    var publicNav = el("nav", { class: "public-nav" });
    var navItems = [["tab_home", "/"], ["about", "/about.html"], ["contact", "/contact.html"]];
    function label() {
      account.textContent = me ? (me.staff ? me.staff.name : me.name) : t("sign_in");
      sw.textContent = t("lang_other");
      sw.setAttribute("lang", lang() === "en" ? "ar" : "en");
      publicNav.replaceChildren();
      publicNav.setAttribute("aria-label", lang() === "ar" ? "التنقل الرئيسي" : "Main navigation");
      navItems.forEach(function (item) {
        var link = el("a", { attrs: { href: item[1] } }, t(item[0]));
        if (location.pathname.replace(/\.html$/, "") === item[1].replace(/\.html$/, "")) link.setAttribute("aria-current", "page");
        publicNav.appendChild(link);
      });
      footer(foot);
    }
    sw.addEventListener("click", function () {
      store.set(KEY, lang() === "en" ? "ar" : "en");
      applyLang();
      label();
      if (renderFn) renderFn();
    });
    label();
    if (!me) signedIn(function (who) { me = who; account.textContent = who.name; account.setAttribute("href", who.href); });
    document.body.insertBefore(el("div", { class: "topbar-shell" }, el("header", { class: "topbar" }, brand, el("span", { class: "topbar-end" }, sw, account))), document.body.firstChild);
    if (!opts || opts.footer !== false) document.querySelector(".topbar").appendChild(publicNav);
    motion();
    // The door scanner shows only the camera and the result (brainstorm idea 12): no footer there.
    if (!opts || opts.footer !== false) document.body.appendChild(foot);
    if (renderFn) renderFn();
  }

  /**
   * On pages opened without a session check (home, About, sign-in...): when this
   * browser holds a staff session, show who is signed in, linking back to their
   * page, instead of "Sign in". Asks only when a session was confirmed here before.
   */
  async function signedIn(show) {
    var kind = store.get(SESSION_KEY);
    if (kind === "party") {
      var r = await call("GET", "/api/me");
      if (r.ok && r.body.staff) { csrf = r.body.csrf; show({ name: r.body.staff.name, href: r.body.staff.role === "door" ? "/scan.html" : "/dashboard.html" }); return; }
      if (r.status === 401) store.del(SESSION_KEY);
    } else if (kind === "platform") {
      var p = await call("GET", "/api/platform/me");
      var who = p.ok && (p.body.site_owner || p.body.organiser);
      if (who) { show({ name: who.name, href: "/platform" }); return; }
      if (p.status === 401) store.del(SESSION_KEY);
    }
  }

  /** The top bar gets a shadow once the page scrolls (it then floats over the content). */
  function motion() {
    var shell = document.querySelector(".topbar-shell");
    var onScroll = function () { if (shell) shell.classList.toggle("scrolled", window.scrollY > 8); };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }

  // Instagram glyph drawn as a plain outline (rounded square, lens, dot): an icon, not an emoji.
  function instagramIcon() {
    var ns = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    [["rect", { x: 3, y: 3, width: 18, height: 18, rx: 5 }], ["circle", { cx: 12, cy: 12, r: 4 }], ["circle", { cx: 17.3, cy: 6.7, r: 1.1, fill: "currentColor" }]]
      .forEach(function (s) {
        var n = document.createElementNS(ns, s[0]);
        Object.keys(s[1]).forEach(function (k) { n.setAttribute(k, s[1][k]); });
        if (!s[1].fill) { n.setAttribute("fill", "none"); n.setAttribute("stroke", "currentColor"); n.setAttribute("stroke-width", "2"); }
        svg.appendChild(n);
      });
    return svg;
  }

  // The footer (owner: after Nova's): Sahra and one line on what it is, then Site,
  // Get in touch and Legal; below, the copyright and the Nova credit.
  var WHATSAPP = "201119990639", EMAIL = "novadevco@icloud.com";
  function footer(node) {
    clear(node);
    var logo = el("img", { attrs: { src: NOVA_LOGO, alt: "", width: 24, height: 24 } });
    logo.addEventListener("error", function () { logo.remove(); });
    var col = function (title, links) {
      return el("nav", { class: "f-col", attrs: { "aria-label": title } }, el("p", { class: "f-title", text: title }),
        el("ul", null, links.map(function (l) {
          return el("li", null, el("a", { text: l[0], attrs: { href: l[1], dir: l[2] ? "ltr" : null, target: l[3] ? "_blank" : null, rel: l[3] ? "noopener" : null } }));
        })));
    };
    node.appendChild(el("div", { class: "f-top" },
      el("div", { class: "f-brand" },
        el("a", { class: "brand", attrs: { href: "/" } }, el("img", { attrs: { src: "/img/sahra-mark.svg", alt: "", width: 28, height: 28 } }), "Sahra"),
        el("p", { text: t("f_desc") })),
      col(t("f_site"), [[t("tab_home"), "/"], [t("about"), "/about.html"], [t("contact"), "/contact.html"], [t("find_tickets"), "/find"], [t("sign_in"), "/signin.html"]]),
      col(t("f_touch"), [[t("f_wa"), "https://wa.me/" + WHATSAPP, false, true], [t("email"), "mailto:" + EMAIL], [t("f_ig"), NOVA_INSTAGRAM, false, true]]),
      col(t("f_legal"), [[t("privacy"), "/privacy.html"], [t("terms"), "/terms.html"]])));
    node.appendChild(el("div", { class: "f-bottom" },
      el("span", { text: "\u00a9 " + new Date().getFullYear() + " Sahra. " + t("f_rights") }),
      el("span", { class: "nova" },
        el("a", { class: "credit", attrs: { href: NOVA_URL, target: "_blank", rel: "noopener" } }, logo, el("span", { text: t("built_by") })),
        el("a", { class: "icon-link", attrs: { href: NOVA_INSTAGRAM, target: "_blank", rel: "noopener", "aria-label": "Nova on Instagram" } }, instagramIcon()))));
  }

  /**
   * The organiser's contact (brainstorm idea 16) as a card: call, WhatsApp (only for a
   * number in international form, "+..."), email and the availability line. The words
   * make clear the organiser answers, not Sahra. null when there is no contact.
   */
  function contactCard(support) {
    if (!support || !support.phone) return null;
    var digits = support.phone.replace(/[^0-9]/g, "");
    var links = [el("a", { class: "btn small-btn", text: t("ct_call"), attrs: { href: "tel:" + support.phone.replace(/[^0-9+]/g, "") } })];
    if (support.phone.charAt(0) === "+") links.push(el("a", { class: "btn small-btn", text: t("ct_whatsapp"), attrs: { href: "https://wa.me/" + digits, target: "_blank", rel: "noopener" } }));
    if (support.email) links.push(el("a", { class: "btn small-btn", text: t("ct_email"), attrs: { href: "mailto:" + support.email } }));
    return el("section", { class: "card contact-card" },
      el("p", { class: "small muted", text: t("ct_title") }),
      el("p", { class: "ct-phone", text: support.phone, attrs: { dir: "ltr" } }),
      support.note ? el("p", { class: "small", text: support.note, attrs: { dir: "auto" } }) : null,
      el("div", { class: "ct-links" }, links),
      el("p", { class: "small muted", text: t("ct_hint") }));
  }

  /** A fresh random token (256 bits, base64url): the sign-up token. */
  function token() {
    var b = new Uint8Array(32);
    crypto.getRandomValues(b);
    var s = "";
    for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  return { t: t, el: el, clear: clear, api: api, errorText: errorText, money: money, amount: amount, when: when, time: time, rel: rel,
    lang: lang, boot: boot, store: store, SESSION_KEY: SESSION_KEY, token: token, title: title, problem: problem, signinView: signinView, contactCard: contactCard, ref: function (id) { return id ? "SAH-" + String(id).slice(0, 6) : ""; } };
})();
