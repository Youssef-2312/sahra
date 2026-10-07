// Shared helpers for the bare test pages.
"use strict";
var Sahra = (function () {
  var csrf = null;
  function b64url(bytes) {
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function token() {
    var b = new Uint8Array(32);
    crypto.getRandomValues(b);
    return b64url(b);
  }
  async function me() {
    var r = await fetch("/api/me", { credentials: "same-origin" });
    if (!r.ok) return null;
    var j = await r.json();
    csrf = j.csrf;
    return j;
  }
  async function post(path, body) {
    var r = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-sahra-csrf": csrf || "" },
      body: JSON.stringify(body || {}),
    });
    var j = await r.json().catch(function () { return {}; });
    return { status: r.status, body: j };
  }
  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) {} },
  };
  me().then(function (m) {
    var el = document.getElementById("account");
    if (el && m) el.textContent = m.staff.name + " (" + m.staff.role + ", " + m.party.name + ")";
  });
  return { token: token, me: me, post: post, store: store };
})();
