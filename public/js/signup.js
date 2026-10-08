// Guest sign-up and "resend my link" (bare test page). The sign-up token is
// generated once and saved until the request is confirmed, so a retry after
// "pending" is the same request, not a second ticket.
"use strict";
(function () {
  var party = new URLSearchParams(location.search).get("party") || "";
  var info = document.getElementById("info");
  var result = document.getElementById("result");
  var widgets = {};
  var siteKey = null;
  var tokenKey = "sahra_signup_" + party;

  function show(el, v) { el.textContent = typeof v === "string" ? v : JSON.stringify(v, null, 2); }

  window.sahraTurnstileReady = function () {
    if (!siteKey || widgets.signup !== undefined) return;
    widgets.signup = turnstile.render("#turnstile-signup", { sitekey: siteKey });
    widgets.resend = turnstile.render("#turnstile-resend", { sitekey: siteKey });
  };

  // Target about 250 KB (server maximum 600,000 bytes): longest side about 1600 px,
  // JPEG, quality stepped down until it fits. An image already small enough (and of
  // an accepted type) is sent as it is, so amounts and references stay sharp.
  var TARGET = 250 * 1000;
  var ACCEPTED = ["image/jpeg", "image/png", "image/webp"];
  async function compress(file) {
    if (file.size <= TARGET && ACCEPTED.indexOf(file.type) >= 0) return file;
    var bmp = await createImageBitmap(file);
    var scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    var c = document.createElement("canvas");
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    var g = c.getContext("2d");
    // JPEG has no transparency: white behind it, not black.
    g.fillStyle = "#fff";
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(bmp, 0, 0, c.width, c.height);
    var blob = null;
    for (var q = 0.85; q >= 0.4; q -= 0.1) {
      blob = await new Promise(function (resolve) { c.toBlob(resolve, "image/jpeg", q); });
      if (blob && blob.size <= TARGET) break;
    }
    return blob;
  }
  function kb(n) { return Math.round(n / 1000) + " KB"; }

  async function load() {
    var r = await fetch("/api/guest/parties/" + encodeURIComponent(party));
    var j = await r.json();
    if (!r.ok) return show(info, j);
    document.getElementById("title").textContent = "Ticket request: " + j.party.name;
    siteKey = j.turnstile_site_key;
    show(info, j.full ? "This party is full. Requests are closed." : "Places left: " + j.places_left +
      (siteKey ? "" : "\nThe bot check is not configured: requests are closed."));
    var f = document.getElementById("signup");
    f.people.max = j.max_people_per_ticket;
    if (j.form.screenshot === "none") document.getElementById("shot-row").hidden = true;
    f.screenshot.required = j.form.screenshot === "required";
    var qs = document.getElementById("questions");
    j.form.questions.forEach(function (q) {
      var p = document.createElement("p");
      var l = document.createElement("label");
      l.textContent = q.label + (q.required ? " " : " (optional) ");
      var input;
      if (q.type === "choice") {
        input = document.createElement("select");
        var blank = document.createElement("option");
        blank.value = "";
        input.appendChild(blank);
        q.options.forEach(function (o) { var op = document.createElement("option"); op.value = o; op.textContent = o; input.appendChild(op); });
      } else {
        input = document.createElement("input");
        input.maxLength = 500;
      }
      input.dataset.q = q.id;
      input.required = q.required;
      l.appendChild(input);
      p.appendChild(l);
      qs.appendChild(p);
    });
    f.hidden = j.full || !siteKey;
    document.getElementById("resend").hidden = !siteKey;
    if (window.turnstile) window.sahraTurnstileReady();
  }

  document.getElementById("signup").addEventListener("submit", async function (e) {
    e.preventDefault();
    var f = e.target;
    var token = Sahra.store.get(tokenKey) || Sahra.token();
    Sahra.store.set(tokenKey, token);
    var answers = {};
    f.querySelectorAll("[data-q]").forEach(function (el) { if (el.value.trim()) answers[el.dataset.q] = el.value; });
    var fd = new FormData();
    fd.set("signup", token);
    fd.set("name", f.name.value);
    fd.set("email", f.email.value);
    fd.set("people", f.people.value);
    fd.set("answers", JSON.stringify(answers));
    fd.set("cf-turnstile-response", turnstile.getResponse(widgets.signup) || "");
    var sizeNote = "";
    if (f.screenshot.files[0]) {
      var original = f.screenshot.files[0];
      var shot = await compress(original);
      fd.set("screenshot", shot, shot === original ? original.name : "screenshot.jpg");
      sizeNote = "Screenshot: " + kb(shot.size) + (shot === original ? " (sent as it is)" : " (made smaller from " + kb(original.size) + ")") + "\n";
    }
    show(result, sizeNote + "Sending...");
    var r = await fetch("/api/guest/parties/" + encodeURIComponent(party) + "/signup", { method: "POST", body: fd, credentials: "same-origin" });
    var j = await r.json().catch(function () { return {}; });
    turnstile.reset(widgets.signup);
    if (r.ok) {
      Sahra.store.del(tokenKey);
      result.textContent = sizeNote + "Request received. Keep this link private and open it to see your ticket: ";
      var a = document.createElement("a");
      a.href = j.link;
      a.textContent = location.origin + j.link;
      result.appendChild(a);
    } else if (j.status === "pending") {
      show(result, "Not confirmed yet. Press the button again (your request is kept).");
    } else {
      Sahra.store.del(tokenKey);
      show(result, j);
    }
  });

  document.getElementById("resend").addEventListener("submit", async function (e) {
    e.preventDefault();
    var r = await fetch("/api/guest/parties/" + encodeURIComponent(party) + "/resend", {
      method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: e.target.email.value, turnstile: turnstile.getResponse(widgets.resend) || "" }),
    });
    turnstile.reset(widgets.resend);
    show(document.getElementById("resend-result"), await r.json().catch(function () { return {}; }));
  });

  load();
})();
