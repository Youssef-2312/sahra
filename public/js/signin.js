// Sign-in for organisers and party staff (brainstorm idea 27): a short panel and
// one "Continue with Google" button per kind of account. No passwords and no
// email sign-in exist; door staff use their invitation link instead.
"use strict";
(function () {
  var t = Sahra.t, el = Sahra.el;
  var app = document.getElementById("app");

  function option(title, hint, action) {
    return el("section", { class: "card" },
      el("h2", { text: title }),
      el("p", { class: "muted", text: hint }),
      el("form", { attrs: { method: "post", action: action } },
        el("button", { class: "btn primary", text: t("si_google"), attrs: { type: "submit" } })));
  }

  // One of the home page's party photos behind the panel; when it is missing the panel keeps its gradient.
  function photo() {
    var img = el("img", { attrs: { src: "/img/hero/hero-3.jpg", alt: "", decoding: "async" } });
    img.addEventListener("error", function () { img.remove(); });
    return img;
  }

  function render() {
    Sahra.clear(app);
    Sahra.title(t("si_title"));
    app.appendChild(el("div", { class: "signin-wrap" },
      el("div", { class: "signin-panel" }, photo(), el("p", { class: "label-line", text: t("si_title") }), el("h1", { text: t("si_head") }), el("p", { text: t("si_text") })),
      el("div", null,
        option(t("si_staff"), t("si_staff_hint"), "/api/auth/google/start"),
        option(t("si_org"), t("si_org_hint"), "/api/auth/platform/start"),
        el("p", { class: "small muted", text: t("si_invite_only") }),
        el("p", { class: "small muted", text: t("si_door") }))));
  }

  Sahra.boot({ render: render });
})();
