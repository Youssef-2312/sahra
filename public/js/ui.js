// Shared helpers for the Phase 5 pages (load after i18n.js). Plain browser
// JavaScript, no libraries. Exposes one global: Sahra.
//
//   Sahra.t(key, vars)          wording in the current language (falls back to English)
//   Sahra.el(tag, props, ...)   build an element; props: class, text, attrs, on, hidden
//   Sahra.api.get/post(path)    fetch JSON; { status, body, ok }; network errors -> status 0
//   Sahra.money(n)              "EGP 250" / "250 ج.م."; Sahra.when(ms, tz), Sahra.rel(ms)
//   Sahra.boot({ render })      top bar + language switch; render() runs again on a switch
"use strict";
var Sahra = (function () {
  var KEY = "sahra_lang";
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

  function money(n) {
    if (!n) return t("free");
    try { return new Intl.NumberFormat(locale(), { style: "currency", currency: "EGP", maximumFractionDigits: 0 }).format(n); }
    catch (e) { return "EGP " + n; }
  }

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

  /** Top bar (brand + language switch) at the start of <body>; `render` runs now and after a switch. */
  function boot(opts) {
    renderFn = (opts && opts.render) || null;
    applyLang();
    var bar = el("header", { class: "topbar" },
      el("a", { class: "brand", text: "Sahra", attrs: { href: "/" } }),
      el("button", { class: "lang-switch", text: t("lang_other"), attrs: { type: "button", lang: lang() === "en" ? "ar" : "en" },
        on: { click: function () {
          store.set(KEY, lang() === "en" ? "ar" : "en");
          applyLang();
          this.textContent = t("lang_other");
          this.setAttribute("lang", lang() === "en" ? "ar" : "en");
          if (renderFn) renderFn();
        } } }));
    document.body.insertBefore(bar, document.body.firstChild);
    if (renderFn) renderFn();
  }

  return { t: t, el: el, clear: clear, api: api, errorText: errorText, money: money, when: when, time: time, rel: rel,
    lang: lang, boot: boot, store: store };
})();
