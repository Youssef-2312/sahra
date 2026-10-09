// Contact form (contact.html). "Send message" emails it to us through FormSubmit
// (owner decision; this page's policy allows connecting to formsubmit.co only).
// "Message sent" is shown only when FormSubmit answers that it accepted it.
// WhatsApp and email open those apps with the message filled in; nothing is
// claimed as sent then. Sahra itself stores nothing. One form per language.
"use strict";
(function () {
  var WHATSAPP = "201119990639";
  var EMAIL = "novadevco@icloud.com";
  var FORMSUBMIT = "https://formsubmit.co/ajax/db6a97da86c51e677ae5d16e12abd9ab";

  document.querySelectorAll("form[data-contact]").forEach(function (form) {
    var busy = false;
    var status = form.querySelector("[data-status]");
    function say(cls, text) { status.className = "notice " + cls; status.textContent = text; status.hidden = false; }
    form.addEventListener("submit", async function (e) {
      e.preventDefault();
      if (busy) return;
      var via = e.submitter ? e.submitter.getAttribute("data-via") : "form";
      var f = form.elements;
      var ar = Sahra.lang() === "ar";
      var v = function (k) { return f[k] && typeof f[k].value === "string" ? f[k].value.trim() : ""; };
      var name = v("name"), email = v("email"), message = v("message");
      if (!name || !email || !message || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        say("no", ar ? "أضف اسمك وبريدك الإلكتروني ورسالة قصيرة." : "Please add your name, your email and a short message.");
        (!name ? f.name : !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? f.email : f.message).focus();
        return;
      }
      var lines = [
        ar ? "مرحبًا، أريد تنظيم حفلة مع سهرة." : "Hi, I would like to host a party with Sahra.",
        (ar ? "الاسم: " : "Name: ") + name,
        (ar ? "البريد: " : "Email: ") + email,
      ];
      if (v("phone")) lines.push((ar ? "الهاتف: " : "Phone: ") + v("phone"));
      lines.push((ar ? "التاريخ: " : "Date: ") + (v("date") || (ar ? "لم يُحدد بعد" : "not decided yet")));
      if (v("guests")) lines.push((ar ? "الضيوف: " : "Guests: ") + v("guests"));
      lines.push("", message);
      var text = lines.join("\n");
      var subject = ar ? "تنظيم حفلة مع سهرة" : "Hosting a party with Sahra";

      if (via === "whatsapp") { status.hidden = true; window.open("https://wa.me/" + WHATSAPP + "?text=" + encodeURIComponent(text), "_blank", "noopener"); return; }
      if (via === "email") { status.hidden = true; location.href = "mailto:" + EMAIL + "?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(text); return; }

      if (!f.consent.checked) {
        say("no", ar ? "وافق على إرسال بياناتك عبر FormSubmit، أو تابع على واتساب أو البريد." : "Please agree to sending your details through FormSubmit, or continue in WhatsApp or by email.");
        f.consent.focus();
        return;
      }
      if (v("_honey")) return; // filled only by bots
      busy = true;
      var button = form.querySelector("button[data-via=form]");
      button.disabled = true;
      say("info", ar ? "جارٍ الإرسال..." : "Sending...");
      var ok = false;
      try {
        var r = await fetch(FORMSUBMIT, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ name: name, email: email, phone: v("phone"), date: v("date") || (ar ? "لم يُحدد بعد" : "not decided yet"), guests: v("guests"),
            message: message, _subject: subject, _template: "table", _captcha: "false", _replyto: email }),
        });
        var j = await r.json().catch(function () { return {}; });
        ok = r.ok && (j.success === true || j.success === "true");
      } catch (err) { ok = false; }
      busy = false;
      button.disabled = false;
      if (ok) {
        form.reset();
        say("yes", ar ? "تم إرسال رسالتك. سنرد عليك بالبريد." : "Message sent. We will reply by email.");
      } else {
        say("no", ar ? "تعذّر الإرسال الآن. حاول مرة أخرى، أو تابع على واتساب أو البريد." : "It could not be sent just now. Try again, or continue in WhatsApp or by email.");
      }
    });
  });
})();
