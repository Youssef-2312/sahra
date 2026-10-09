// Find my tickets: /find (brainstorm idea 4, owner decision). On a device that
// does not remember the guest's tickets, they type their email and receive ONE
// email with the links to all their tickets across parties. No accounts. The
// answer on screen is the same whether or not the address has tickets
// (POST /api/guest/find); the security check (Turnstile) and limits are on the server.
"use strict";
(function () {
  var t = Sahra.t, el = Sahra.el;
  var app = document.getElementById("app");
  var siteKey = null, ready = false, widget, loaded = false, sent = null, error = null, busy = false, typed = "";

  function mount() {
    if (!ready || !siteKey || !window.turnstile) return;
    var box = document.getElementById("turnstile-find");
    if (!box || box.childElementCount) return;
    widget = window.turnstile.render("#turnstile-find", { sitekey: siteKey, language: Sahra.lang() });
  }
  window.sahraTurnstileReady = function () { ready = true; mount(); };

  function render() {
    Sahra.clear(app);
    Sahra.title(t("fd_title"));
    var head = el("header", { class: "find-head" },
      el("p", { class: "label-line", text: t("fd_label") }),
      el("h1", { text: t("fd_title") }),
      el("p", { class: "lede", text: t("fd_lede") }));
    app.appendChild(head);
    if (!loaded) { app.appendChild(el("p", { class: "muted", text: t("loading") })); return; }
    if (sent) {
      app.appendChild(el("section", { class: "card find-card", attrs: { role: "status" } },
        el("h2", { text: t("fd_sent_title") }),
        el("p", { text: t("fd_sent_p", { email: sent }) }),
        el("ul", { class: "find-points" }, ["fd_sent1", "fd_sent2", "fd_sent3"].map(function (k) { return el("li", { text: t(k) }); })),
        el("button", { class: "btn small-btn", text: t("fd_again"), attrs: { type: "button" }, on: { click: function () { sent = null; render(); mount(); } } })));
      return;
    }
    if (!siteKey) { app.appendChild(el("p", { class: "notice maybe", text: t("fd_unavailable") })); return; }
    var input = el("input", { attrs: { id: "find-email", name: "email", type: "email", autocomplete: "email", inputmode: "email", required: true, maxlength: 254, dir: "ltr", value: typed } });
    input.addEventListener("input", function () { typed = input.value; });
    var f = el("form", { class: "card find-card", attrs: { novalidate: true } },
      el("div", { class: "field" }, el("label", { text: t("fd_email"), attrs: { for: "find-email" } }), input,
        el("span", { class: "hint", text: t("fd_email_h") })),
      el("div", { attrs: { id: "turnstile-find" }, class: "find-check" }),
      error ? el("p", { class: "notice no", text: error, attrs: { role: "alert" } }) : null,
      el("button", { class: "btn primary wide-btn", text: busy ? t("fd_sending") : t("fd_send"), attrs: { type: "submit", disabled: busy } }),
      el("p", { class: "small muted find-foot", text: t("fd_foot") }));
    f.addEventListener("submit", submit);
    app.appendChild(f);
    app.appendChild(el("p", { class: "small muted find-help" }, t("fd_help"), " ", el("a", { text: t("contact"), attrs: { href: "/contact" } })));
    mount();
  }

  async function submit(e) {
    e.preventDefault();
    var email = typed.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { error = t("fd_bad_email"); render(); document.getElementById("find-email").focus(); return; }
    var token = window.turnstile && widget !== undefined ? window.turnstile.getResponse(widget) || "" : "";
    if (!token) { error = t("fd_check"); render(); return; }
    busy = true; error = null; render();
    var r = await Sahra.api.post("/api/guest/find", { email: email, turnstile: token });
    busy = false;
    if (window.turnstile && widget !== undefined) { try { window.turnstile.reset(widget); } catch (x) {} }
    if (r.ok) { sent = email; typed = ""; render(); return; }
    error = r.status === 429 ? t("fd_wait") : Sahra.errorText(r);
    widget = undefined;
    render();
  }

  Sahra.boot({ render: function () { widget = undefined; render(); } });
  Sahra.api.get("/api/guest/find").then(function (r) {
    loaded = true;
    siteKey = r.ok ? r.body.turnstile_site_key : null;
    render();
  });
})();
