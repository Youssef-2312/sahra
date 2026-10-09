// The one sign-in for party owners, their teams and the site owner (Sahra.signinView
// in ui.js, shared with /platform). No passwords and no email sign-in; door staff
// use their invitation link instead.
"use strict";
(function () {
  var t = Sahra.t;
  var app = document.getElementById("app");

  function render() {
    Sahra.clear(app);
    Sahra.title(t("si_title"));
    app.appendChild(Sahra.signinView());
  }

  Sahra.boot({ render: render });
})();
