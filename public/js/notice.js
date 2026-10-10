// Pages the server answers itself (src/auth/notices.ts): a sign-in that failed or
// has no access, the party choice, "signed in", and "page not found". The server
// sends the English text as a plain card; this shows it in the site's look, in
// English or Arabic, with the usual top bar and footer. The party choice keeps the
// server's own forms (their party ids and names come escaped from the server).
"use strict";
(function () {
  var t = Sahra.t, el = Sahra.el;
  var app = document.getElementById("app");
  var key = app.getAttribute("data-notice") || "not_found";
  var back = app.getAttribute("data-back") || "/signin";
  var detail = app.getAttribute("data-detail") || "";
  var next = app.getAttribute("data-next") || "";
  // Taken out before the first render, then placed in the new layout on every render.
  var forms = [].slice.call(app.querySelectorAll("form.pick"));
  var organiser = app.querySelector("[data-platform]");
  var lost = key === "not_found";

  function has(k) { return Object.prototype.hasOwnProperty.call(SahraText.en, k); }

  function link(text, href, primary) { return [text, href, primary]; }

  function actions() {
    if (key === "choose") {
      var list = el("div", { class: "notice-picks" });
      forms.forEach(function (f) {
        var b = f.querySelector("button");
        var role = b.getAttribute("data-role") || "";
        b.replaceChildren(el("span", { class: "pick-name", text: b.getAttribute("data-name") || "" }),
          el("span", { class: "pick-role", text: has("nt_role_" + role) ? t("nt_role_" + role) : role }));
        list.appendChild(f);
      });
      if (organiser) { organiser.textContent = t("nt_organiser"); list.appendChild(organiser); }
      return { extra: list, list: [] };
    }
    if (next) return { list: [link(t("nt_continue"), next, true)] };
    if (lost) return { list: [link(t("nt_home"), "/", true), link(t("nt_find"), "/find", false)] };
    var label = back === "/platform" ? t("nt_back_platform") : t("nt_back_signin");
    return { list: [link(label, back, true), link(t("nt_home"), "/", false)] };
  }

  function render() {
    var title = has("nt_" + key + "_t") ? t("nt_" + key + "_t") : t("nt_not_found_t");
    var text = has("nt_" + key) ? t("nt_" + key) : t("nt_not_found");
    var a = actions();
    Sahra.clear(app);
    Sahra.title(title);
    app.appendChild(Sahra.problem({
      kicker: lost ? t("nt_kicker_404") : t("nt_kicker_signin"), big: lost ? "404" : null, title: title, text: text,
      photo: lost ? "/img/hero/hero-19.jpg" : null, extra: a.extra, actions: a.list, code: detail,
      hint: key === "no_access" || lost ? t("nt_guest_hint") : null,
    }));
  }

  Sahra.boot({ render: render });
})();
