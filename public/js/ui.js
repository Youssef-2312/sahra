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
  // Dates read DD/MM/YYYY everywhere (owner), with the weekday and the time: "Thu 29/10/2026, 20:00".
  function dmy(ms, tz) {
    var o = { day: "2-digit", month: "2-digit", year: "numeric" };
    try {
      var p = {};
      new Intl.DateTimeFormat("en-GB", Object.assign(o, tz ? { timeZone: tz } : {})).formatToParts(ms).forEach(function (x) { p[x.type] = x.value; });
      return p.day + "/" + p.month + "/" + p.year;
    } catch (e) { var d = new Date(ms); return ("0" + d.getDate()).slice(-2) + "/" + ("0" + (d.getMonth() + 1)).slice(-2) + "/" + d.getFullYear(); }
  }
  function weekday(ms, tz) {
    try { return new Intl.DateTimeFormat(locale(), Object.assign({ weekday: "short" }, tz ? { timeZone: tz } : {})).format(ms); } catch (e) { return ""; }
  }
  function when(ms, tz) {
    if (ms === null || ms === undefined) return "";
    return (weekday(ms, tz) + " " + dmy(ms, tz)).trim() + (lang() === "ar" ? "، " : ", ") + time(ms, tz);
  }
  /** Just the date: "29/10/2026". */
  function date(ms, tz) { return ms === null || ms === undefined ? "" : dmy(ms, tz); }
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
  // ------------------------------------------------------------- dialogs
  // The site's own confirm / alert / prompt (owner: no plain browser pop-ups): a
  // modal <dialog> in the site's look, so focus stays inside, Escape cancels and
  // Arabic reads right to left. Each returns a promise.
  //   Sahra.confirm(text, { ok, danger })  -> true / false
  //   Sahra.notify(text)                   -> resolves when closed
  //   Sahra.ask(text, { value, ok })        -> the typed text, or null if cancelled
  function dialog(o) {
    var previousFocus = document.activeElement;
    return new Promise(function (done) {
      var input = o.input ? el("input", { class: "dlg-input", attrs: { type: "text", dir: "auto", value: o.value || "", "aria-label": o.text, readonly: !!o.readonly } }) : null;
      var ok = el("button", { class: "btn small-btn " + (o.danger ? "no" : "primary"), text: o.ok || t("dlg_ok"), attrs: { type: "submit", value: "ok" } });
      var cancel = o.alert ? null : el("button", { class: "btn small-btn", text: t("dlg_cancel"), attrs: { type: "button" } });
      var form = el("form", { attrs: { method: "dialog" } },
        el("p", { class: "dlg-text", text: o.text }), input,
        el("div", { class: "dlg-actions" }, cancel, ok));
      var d = el("dialog", { class: "dlg", attrs: { "aria-label": o.text } }, form);
      var answered = false;
      function finish(v) { if (answered) return; answered = true; d.close(); d.remove(); if (previousFocus && previousFocus.isConnected) previousFocus.focus(); done(v); }
      form.addEventListener("submit", function (e) { e.preventDefault(); finish(o.input ? input.value : true); });
      if (cancel) cancel.addEventListener("click", function () { finish(o.input ? null : false); });
      // Escape, or the browser closing it: the same as Cancel.
      d.addEventListener("cancel", function (e) { e.preventDefault(); finish(o.alert ? true : o.input ? null : false); });
      document.body.appendChild(d);
      d.showModal();
      (input || ok).focus();
      if (input) input.select();
    });
  }
  // One clipboard action for guests and staff; a blocked clipboard opens
  // selected text in the site's dialog instead of claiming it was copied.
  function copyButton(value, label) {
    var b = el("button", { class: "btn small-btn copy-btn", text: label || t("copy"), attrs: { type: "button" } });
    var timer;
    b.addEventListener("click", async function () {
      b.disabled = true;
      clearTimeout(timer);
      try { await navigator.clipboard.writeText(String(value)); b.textContent = t("copied"); }
      catch (e) { await ask(t("copy_fallback"), { value: String(value), readonly: true }); }
      finally { b.disabled = false; if (b.isConnected && document.activeElement === document.body) b.focus(); }
      timer = setTimeout(function () { b.textContent = label || t("copy"); }, 2000);
    });
    return b;
  }

  function confirmBox(text, opts) { return dialog({ text: text, ok: opts && opts.ok, danger: opts && opts.danger }); }
  function notify(text) { return dialog({ text: text, alert: true }); }
  function ask(text, opts) { return dialog({ text: text, input: true, value: opts && opts.value, readonly: opts && opts.readonly, ok: opts && opts.ok }); }

  /**
   * The one sign-in (brainstorm idea 27; owner: one sign-in for everyone who runs
   * parties): a photo panel and one "Continue with Google". The server finds what
   * the account may open (its party, My parties, the site-owner panel) and goes
   * there. Used by /signin and by /platform when signed out. `extra`: an error box.
   */
  function signinView(extra) {
    var img = el("img", { attrs: { src: "/img/hero/hero-24.jpg", alt: "", decoding: "async" } });
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
    var img = el("img", { attrs: { src: o.photo || "/img/hero/hero-20.jpg", alt: "", decoding: "async" } });
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
  // Keep ordinary form values and open sections during an in-page language
  // change. Consent is reviewed again; files cannot be restored by a browser.
  function captureDrafts() {
    return { forms: [].map.call(document.querySelectorAll("main form"), function (f) {
      return [].map.call(f.elements, function (x) {
        if (!x.name || /^(file|hidden|submit|button|password)$/.test(x.type) || /accept|consent/.test(x.name)) return null;
        return { name: x.name, type: x.type, value: x.value, checked: x.checked };
      });
    }), details: [].map.call(document.querySelectorAll("main details"), function (d) { return d.open; }) };
  }
  function restoreDrafts(draft) {
    [].forEach.call(document.querySelectorAll("main form"), function (f, i) {
      var prior = draft.forms[i];
      if (!prior) return;
      [].forEach.call(f.elements, function (x, j) {
        var v = prior[j];
        if (!v || x.name !== v.name || x.type !== v.type) return;
        x.value = v.value;
        if (x.type === "checkbox" || x.type === "radio") x.checked = v.checked;
      });
    });
    [].forEach.call(document.querySelectorAll("main details"), function (d, i) { if (draft.details[i] !== undefined) d.open = draft.details[i]; });
  }

  function boot(opts) {
    renderFn = (opts && opts.render) || null;
    var me = (opts && opts.me) || null;
    applyLang();
    var brand = el("a", { class: "brand", attrs: { href: "/" } }, el("img", { attrs: { src: "/img/sahra-mark.svg", alt: "", width: 28, height: 28 } }), "Sahra");
    var account = el("a", { class: "btn small-btn", attrs: { href: me ? (me.staff.role === "door" ? "/scan.html" : "/dashboard.html") : "/signin.html" } });
    // The signed-in person's name on the button; never a whole email address (owner), and the full name on hover.
    function showName(n) {
      n = String(n || "");
      account.textContent = n.indexOf("@") > 0 ? n.slice(0, n.indexOf("@")) : n;
      account.setAttribute("title", n);
    }
    var sw = el("button", { class: "lang-switch", attrs: { type: "button" } });
    var foot = el("footer", { class: "site-footer" });
    var publicNav = el("nav", { class: "public-nav" });
    var navItems = [["tab_home", "/"], ["about", "/about.html"], ["contact", "/contact.html"]];
    function label() {
      if (me) showName(me.staff ? me.staff.name : me.name); else account.textContent = t("sign_in");
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
      var draft = captureDrafts();
      store.set(KEY, lang() === "en" ? "ar" : "en");
      applyLang();
      label();
      if (renderFn) renderFn();
      restoreDrafts(draft);
    });
    label();
    if (!me) signedIn(function (who) { me = who; showName(who.name); account.setAttribute("href", who.href); });
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

  // Shared footer: photo invitation and compact black reference-style footer.
  var WHATSAPP = "201119990639", EMAIL = "novadevco@icloud.com";
  function footer(node) {
    clear(node);
    var logo = el("img", { attrs: { src: NOVA_LOGO, alt: "", width: 24, height: 24 } });
    logo.addEventListener("error", function () { logo.remove(); });
    var link = function (label, href, external) {
      return el("a", { text: label, attrs: { href: href, target: external ? "_blank" : null, rel: external ? "noopener" : null } });
    };
    var contactIcon = function (href) {
      if (href.indexOf("instagram.com") >= 0) return instagramIcon();
      var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true");
      var path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", href.indexOf("mailto:") === 0 ? "M3 5h18v14H3ZM3 5l9 8 9-8" : "M7 3H3v4c0 8 6 14 14 14h4v-4l-5-2-2 2c-3-1-6-4-7-7l2-2Z");
      path.setAttribute("fill", "none"); path.setAttribute("stroke", "currentColor"); path.setAttribute("stroke-width", "1.5");
      svg.appendChild(path); return svg;
    };
    var col = function (title, links) {
      return el("nav", { class: "f-col", attrs: { "aria-label": title } }, el("h3", { class: "f-title", text: title }),
        el("ul", null, links.map(function (l) { var a = link(l[0], l[1], l[2]); if (l[3]) { a.setAttribute("dir", "ltr"); a.classList.add("f-contact-link"); a.prepend(contactIcon(l[1])); } return el("li", null, a); })));
    };
    var invitation = el("section", { class: "f-invitation", attrs: { "aria-labelledby": "footer-invitation" } },
      el("div", { class: "f-photos", attrs: { "aria-hidden": "true" } }, [18, 20, 22].map(function (n) {
        return el("img", { attrs: { src: "/img/hero/hero-" + n + ".jpg", alt: "", loading: "lazy", decoding: "async" } });
      })),
      el("p", { class: "f-eyebrow", text: t("f_kicker") }),
      el("h2", { attrs: { id: "footer-invitation" }, text: t("f_invitation") }),
      el("p", { class: "f-invitation-copy", text: t("f_invitation_copy") }),
      el("div", { class: "f-actions" },
        el("a", { class: "btn primary", text: t("f_explore"), attrs: { href: "/#parties" } }),
        el("a", { class: "f-host-link", text: t("f_host"), attrs: { href: "/contact.html" } })));
    var language = el("button", { class: "f-language", text: t("f_switch_language"), attrs: { type: "button", lang: lang() === "en" ? "ar" : "en" } });
    language.addEventListener("click", function () { document.querySelector(".topbar .lang-switch").click(); });
    var chat = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    chat.setAttribute("viewBox", "0 0 24 24"); chat.setAttribute("aria-hidden", "true");
    var outline = document.createElementNS("http://www.w3.org/2000/svg", "path");
    outline.setAttribute("d", "M21 11.5a8.5 8.5 0 0 1-12.4 7.6L3 21l1.9-5.6A8.5 8.5 0 1 1 21 11.5Z");
    outline.setAttribute("fill", "none"); outline.setAttribute("stroke", "currentColor"); outline.setAttribute("stroke-width", "1.6"); chat.appendChild(outline);
    var panel = el("div", { class: "f-panel" },
      el("div", { class: "f-top" },
        el("div", { class: "f-brand" },
          el("a", { class: "brand", attrs: { href: "/" } }, el("img", { attrs: { src: "/img/sahra-mark.svg", alt: "", width: 28, height: 28 } }), "Sahra"),
          el("p", { text: t("f_desc") }),
          el("div", { class: "f-socials" },
            el("a", { class: "icon-link", attrs: { href: NOVA_INSTAGRAM, target: "_blank", rel: "noopener", "aria-label": t("f_nova_instagram") } }, instagramIcon()),
            el("a", { class: "icon-link", attrs: { href: "https://wa.me/" + WHATSAPP, target: "_blank", rel: "noopener", "aria-label": t("f_wa") } }, chat))),
        col(t("f_site"), [[t("tab_home"), "/"], [t("about"), "/about.html"], [t("contact"), "/contact.html"], [t("privacy"), "/privacy.html"], [t("terms"), "/terms.html"]]),
        col(t("f_guests"), [[t("f_explore"), "/#parties"], [t("find_tickets"), "/find"], [t("sign_in"), "/signin.html"]]),
        col(t("f_touch"), [["+20 111 999 0639", "tel:+" + WHATSAPP, false, true], [EMAIL, "mailto:" + EMAIL, false, true], ["@novadev.co", NOVA_INSTAGRAM, true, true]])),
      el("div", { class: "f-bottom" }, language,
        el("span", { class: "f-copyright", text: "\u00a9 " + new Date().getFullYear() + " Sahra. " + t("f_rights") }),
        el("a", { class: "credit f-credit", attrs: { href: NOVA_URL, target: "_blank", rel: "noopener" } }, logo, el("span", { text: t("built_by") }))));
    node.append(invitation, panel);
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
  // ------------------------------------------------------------ finding things

  // Text for matching: lower case, Arabic letter forms folded (alef, yaa, taa marbuta),
  // marks and tatweel removed, spaces collapsed. "Ahmed" finds "ahmed", "احمد" finds "أحمد".
  function fold(v) {
    return String(v == null ? "" : v).toLowerCase()
      .replace(/[\u064B-\u065F\u0670\u0640]/g, "").replace(/[\u0622\u0623\u0625]/g, "\u0627")
      .replace(/\u0649/g, "\u064A").replace(/\u0629/g, "\u0647").replace(/\s+/g, " ").trim();
  }
  /** True when every word of `q` is in one of `fields` (an empty query matches everything). */
  function matches(q, fields) {
    var words = fold(q).split(" ").filter(Boolean);
    if (!words.length) return true;
    var hay = fields.map(fold).join(" \u0001 ");
    return words.every(function (w) { return hay.indexOf(w) >= 0; });
  }
  /**
   * A filter box for a list already on the page: filters as you type (no button),
   * Escape or Clear empties it, and "/" anywhere on the page jumps to it.
   * o: { value, placeholder, label, onChange(text) }.
   */
  function findBox(o) {
    var input = el("input", { attrs: { type: "search", value: o.value || "", placeholder: o.placeholder, "aria-label": o.label || o.placeholder, title: t("find_hint"),
      autocomplete: "off", enterkeyhint: "search", maxlength: 80, dir: "auto", "data-find": "" } });
    var clearBtn = el("button", { class: "btn small-btn find-clear", text: t("find_clear"), attrs: { type: "button", hidden: !o.value } });
    var timer = null;
    function changed() { clearBtn.hidden = !input.value; clearTimeout(timer); timer = setTimeout(function () { o.onChange(input.value); }, 120); }
    input.addEventListener("input", changed);
    input.addEventListener("keydown", function (e) { if (e.key === "Escape" && input.value) { e.preventDefault(); input.value = ""; changed(); } });
    clearBtn.addEventListener("click", function () { input.value = ""; changed(); input.focus(); });
    var f = el("form", { class: "find-box", attrs: { role: "search" } }, input, clearBtn);
    f.addEventListener("submit", function (e) { e.preventDefault(); clearTimeout(timer); o.onChange(input.value); });
    return f;
  }
  // "/" focuses the page's search or filter box (as on most sites), unless typing somewhere already.
  document.addEventListener("keydown", function (e) {
    if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
    var a = document.activeElement, tag = a && a.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (a && a.isContentEditable) || document.querySelector("dialog[open]")) return;
    var box = document.querySelector("[data-find]") || document.querySelector("input[type=search]");
    if (!box) return;
    e.preventDefault();
    box.focus();
    if (box.select) box.select();
  });

  function token() {
    var b = new Uint8Array(32);
    crypto.getRandomValues(b);
    var s = "";
    for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  return { t: t, el: el, clear: clear, api: api, errorText: errorText, money: money, amount: amount, when: when, date: date, time: time, rel: rel,
    lang: lang, boot: boot, store: store, SESSION_KEY: SESSION_KEY, token: token, title: title, problem: problem, signinView: signinView, copyButton: copyButton, fold: fold, matches: matches, findBox: findBox, confirm: confirmBox, notify: notify, ask: ask, contactCard: contactCard, ref: function (id) { return id ? "SAH-" + String(id).slice(0, 6) : ""; } };
})();
