// Shared helpers for the Phase 5 pages (load after i18n.js). Plain browser
// JavaScript, no libraries. Exposes one global: Sahra.
//
//   Sahra.t(key, vars)          wording in the current language (falls back to English)
//   Sahra.el(tag, props, ...)   build an element; props: class, text, attrs, on, hidden
//   Sahra.api.get/post(path)    fetch JSON; { status, body, ok }; network errors -> status 0
//   Sahra.money(n)              "EGP 250" / "250 ج.م."; Sahra.when(ms, tz), Sahra.rel(ms)
//   Sahra.boot({ render, me })  top bar, language switch and site footer; render() runs again on a switch
//
// Top bar: sign-in / account at the start (top-left in English), the language
// switch at the end. Footer (brainstorm idea 28): Privacy and Terms, copyright,
// and in the corner "Built by Nova" with Nova's logo and an Instagram icon next
// to it (Nova's Instagram; Sahra has none). Both links open a new tab; nothing
// loads from those sites until tapped.
"use strict";
var Sahra = (function () {
  var KEY = "sahra_lang";
  var NOVA_URL = "https://bynova.vercel.app/";
  var NOVA_INSTAGRAM = "https://www.instagram.com/nova.dev26/";
  // Nova's logo: a copy of https://bynova.vercel.app/favicon.svg kept in the project (nothing loads from Nova at run time).
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
    var s = (SahraText[lang()] && SahraText[lang()][key]) || SahraText.en[key] || key;
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
    if (method !== "GET" && csrf) h["x-sahra-csrf"] = csrf;
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
      if (!r.ok) return null;
      csrf = r.body.csrf;
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
    var account = el("a", { class: "brand", attrs: { href: "/" } });
    var sw = el("button", { class: "lang-switch", attrs: { type: "button" } });
    var foot = el("footer", { class: "site-footer" });
    function label() {
      account.textContent = me ? me.staff.name : t("sign_in");
      sw.textContent = t("lang_other");
      sw.setAttribute("lang", lang() === "en" ? "ar" : "en");
      footer(foot);
    }
    sw.addEventListener("click", function () {
      store.set(KEY, lang() === "en" ? "ar" : "en");
      applyLang();
      label();
      if (renderFn) renderFn();
    });
    label();
    document.body.insertBefore(el("header", { class: "topbar" }, account, sw), document.body.firstChild);
    // The door scanner shows only the camera and the result (brainstorm idea 12): no footer there.
    if (!opts || opts.footer !== false) document.body.appendChild(foot);
    if (renderFn) renderFn();
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

  function footer(node) {
    clear(node);
    var logo = el("img", { attrs: { src: NOVA_LOGO, alt: "", width: 28, height: 28 } });
    logo.addEventListener("error", function () { logo.remove(); });
    node.appendChild(el("div", null,
      el("div", { class: "links" },
        el("a", { text: t("privacy"), attrs: { href: "/privacy.html" } }),
        el("a", { text: t("terms"), attrs: { href: "/terms.html" } })),
      el("div", { text: "\u00a9 " + new Date().getFullYear() + " Sahra" })));
    node.appendChild(el("div", { class: "nova" },
      el("a", { class: "credit", attrs: { href: NOVA_URL, target: "_blank", rel: "noopener" } }, logo, el("span", { text: t("built_by") })),
      el("a", { class: "icon-link", attrs: { href: NOVA_INSTAGRAM, target: "_blank", rel: "noopener", "aria-label": "Nova on Instagram" } }, instagramIcon())));
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
    lang: lang, boot: boot, store: store, token: token };
})();
