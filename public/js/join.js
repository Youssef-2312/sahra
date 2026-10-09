// Join the door team: /join#t=<invitation> (a link from the party's owner). The
// invitation is in the URL fragment, which browsers never send to servers; the
// page removes it from the address bar at once. Pressing Join uses it once: this
// browser gets its door session (a fresh 256-bit value, kept until the server
// confirms, so a retry is the same join) and goes to the scanner.
"use strict";
(function () {
  var t = Sahra.t, el = Sahra.el;
  var app = document.getElementById("app");
  var m = /[#&]t=([A-Za-z0-9_-]{43})/.exec(location.hash);
  var saved = Sahra.store.get("sahra_join");
  var state = null;
  try { state = saved ? JSON.parse(saved) : null; } catch (e) { state = null; }
  if (m && (!state || state.t !== m[1])) {
    state = { t: m[1], v: Sahra.token() };
    Sahra.store.set("sahra_join", JSON.stringify(state));
  }
  if (m) history.replaceState(null, "", "/join");
  var msg = null, busy = false, done = false;

  function render() {
    Sahra.clear(app);
    Sahra.title(t("j_title"));
    var panel = el("section", { class: "card j-panel" },
      el("p", { class: "label-line", text: t("j_label") }),
      el("h1", { text: t("j_title") }));
    if (!state) {
      panel.appendChild(el("p", { class: "muted", text: t("j_no_link") }));
    } else {
      panel.appendChild(el("p", { class: "muted", text: t("j_text") }));
      panel.appendChild(el("ul", { class: "j-points" }, ["j_p1", "j_p2", "j_p3"].map(function (k) { return el("li", { text: t(k) }); })));
      panel.appendChild(el("button", { class: "btn primary wide-btn", text: busy ? t("j_joining") : t("j_join"), attrs: { type: "button", disabled: busy || done }, on: { click: function () { attempt(0); } } }));
    }
    if (msg) panel.appendChild(el("p", { class: "notice " + msg[0], text: t(msg[1], msg[2]), attrs: { role: "status" } }));
    app.appendChild(panel);
  }

  async function attempt(n) {
    busy = true;
    render();
    var r;
    try {
      r = await fetch("/api/invites/consume", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: state.t, session: state.v }) });
    } catch (e) {
      if (n < 5) return setTimeout(function () { attempt(n + 1); }, 1500);
      busy = false; msg = ["no", "error_network"]; render(); return;
    }
    var j = await r.json().catch(function () { return {}; });
    if (r.status === 200) {
      Sahra.store.del("sahra_join");
      Sahra.store.set(Sahra.SESSION_KEY, "party");
      busy = false; done = true;
      msg = ["yes", "j_joined", { name: j.staff_name }];
      render();
      setTimeout(function () { location.href = "/scan.html"; }, 900);
      return;
    }
    if (r.status === 503 && j.retry && n < 5) return setTimeout(function () { attempt(n + 1); }, 1500);
    busy = false;
    var k = "j_e_" + (j.error || "");
    msg = ["no", SahraText.en[k] ? k : "error_generic"];
    if (r.status !== 503 && r.status !== 429) { done = true; Sahra.store.del("sahra_join"); }
    render();
  }

  Sahra.boot({ render: render });
})();
