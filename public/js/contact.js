// Contact form (contact.html): stores nothing. "Send on WhatsApp" or "Send by
// email" opens that app with the message filled in, addressed to Nova (who
// builds and runs Sahra). The page has one form per language; both work alike.
"use strict";
(function () {
  var WHATSAPP = "201119990639";
  var EMAIL = "novadevco@icloud.com";

  document.querySelectorAll("form[data-contact]").forEach(function (form) {
    var via = "whatsapp";
    form.querySelectorAll("button[data-via]").forEach(function (b) {
      b.addEventListener("click", function () { via = b.getAttribute("data-via"); });
    });
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var f = form.elements;
      var name = f.name.value.trim(), reach = f.reach.value.trim(), message = f.message.value.trim();
      var error = form.querySelector("[data-error]");
      if (!name || !reach || !message) { error.hidden = false; (name ? reach ? f.message : f.reach : f.name).focus(); return; }
      error.hidden = true;
      var ar = Sahra.lang() === "ar";
      var lines = [
        ar ? "مرحبًا، أريد تنظيم حفلة مع سهرة." : "Hi, I would like to host a party with Sahra.",
        (ar ? "الاسم: " : "Name: ") + name,
        (ar ? "للتواصل: " : "Contact: ") + reach,
      ];
      if (f.date.value.trim()) lines.push((ar ? "التاريخ: " : "Date: ") + f.date.value.trim());
      if (f.guests.value) lines.push((ar ? "الضيوف: " : "Guests: ") + f.guests.value);
      lines.push("", message);
      var text = lines.join("\n");
      if (via === "email") {
        location.href = "mailto:" + EMAIL + "?subject=" + encodeURIComponent(ar ? "تنظيم حفلة مع سهرة" : "Hosting a party with Sahra") + "&body=" + encodeURIComponent(text);
      } else {
        window.open("https://wa.me/" + WHATSAPP + "?text=" + encodeURIComponent(text), "_blank", "noopener");
      }
    });
  });
})();
