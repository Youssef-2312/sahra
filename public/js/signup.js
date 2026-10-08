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
    var closedWhy = j.full ? "This party is full. Requests are closed."
      : j.registration.state === "not_open_yet" ? "Requests open at " + new Date(j.registration.opens_at).toLocaleString() + "."
        : j.registration.state === "closed" ? "Requests are closed." : null;
    show(info, (closedWhy || "Places left: " + j.places_left +
      (j.registration.closes_at ? "\nRequests close at " + new Date(j.registration.closes_at).toLocaleString() + "." : "") +
      (j.max_tickets_per_email ? "\nAt most " + j.max_tickets_per_email + " ticket(s) per email address." : "")) +
      (siteKey ? "" : "\nThe bot check is not configured: requests are closed."));
    // Ticket types: a request must name one when the party has any. Prices are EGP per person.
    var sel = document.querySelector("#signup [name=type_id]");
    var typeInfo = document.getElementById("type-info");
    var byId = {};
    j.types.forEach(function (t) {
      byId[t.id] = t;
      var o = document.createElement("option");
      o.value = t.id;
      o.disabled = !t.on_sale;
      o.textContent = t.name + " - " + (t.price ? "EGP " + t.price + " per person" : "free") +
        (t.sold_out ? " (sold out)" : !t.on_sale ? " (not on sale now)" : " (" + t.places_left + " left)");
      sel.appendChild(o);
    });
    function describe() {
      var t = byId[sel.value];
      typeInfo.textContent = t ? [t.description, t.payment_instructions ? "How to pay: " + t.payment_instructions : null]
        .filter(Boolean).join("\n") : (j.payment_instructions ? "How to pay: " + j.payment_instructions : "");
    }
    sel.addEventListener("change", describe);
    document.getElementById("type-row").hidden = j.types.length === 0;
    sel.required = j.types.length > 0;
    var firstOnSale = j.types.filter(function (t) { return t.on_sale; })[0];
    if (firstOnSale) sel.value = firstOnSale.id;
    describe();
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
    f.hidden = !!closedWhy || !siteKey;
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
    if (f.type_id.value) fd.set("type_id", f.type_id.value);
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
      result.textContent = sizeNote + (j.notice ? j.notice + "\n" : "") + "Request received. Keep this link private and open it to see your ticket: ";
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
