// Text pages (About, Contact, Privacy, Terms): both languages are in the HTML;
// show the chosen one, and name the browser tab after it ("About | Sahra").
"use strict";
Sahra.boot({ render: function () {
  document.querySelectorAll("[data-lang]").forEach(function (s) {
    s.hidden = s.getAttribute("data-lang") !== Sahra.lang();
    if (!s.hidden && s.getAttribute("data-tab")) Sahra.title(s.getAttribute("data-tab"));
  });
} });
