// Plain text pages (Privacy, Terms): both languages are in the HTML; show the chosen one.
"use strict";
Sahra.boot({ render: function () {
  document.querySelectorAll("[data-lang]").forEach(function (s) { s.hidden = s.getAttribute("data-lang") !== Sahra.lang(); });
} });
