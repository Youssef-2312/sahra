// Guest sign-up page: /signup.html?party=<id>. Order (owner, brainstorm idea 2):
// party name, date and time; address status; ticket types with prices; a short
// form. The sign-up token is created once and kept until the request is
// confirmed, so a retry after "not confirmed yet" is the same request, never a
// second ticket. A confirmed ticket link is remembered in this browser
// (sahra_tickets) for the home page.
"use strict";
(function () {
  var t = Sahra.t, el = Sahra.el;
  var party = new URLSearchParams(location.search).get("party") || "";
  var tokenKey = "sahra_signup_" + party;
  var draftKey = "sahra_draft_" + party;
  var app = document.getElementById("app");
  var data = null;        // GET /api/guest/parties/:party
  var loadError = null;
  var done = null;        // the confirmed request: { link, earlier }
  var built = false;
  var widgets = {};
  var turnstileReady = false;

  // ------------------------------------------------------------ helpers

  // Target about 250 KB (server maximum 600,000 bytes): longest side about 1600 px,
  // JPEG, quality stepped down until it fits. A small enough image of an accepted
  // type is sent as it is.
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
    g.fillStyle = "#fff";
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(bmp, 0, 0, c.width, c.height);
    var blob = null;
    for (var q = 0.85; q >= 0.4; q -= 0.1) {
      blob = await new Promise(function (ok) { c.toBlob(ok, "image/jpeg", q); });
      if (blob && blob.size <= TARGET) break;
    }
    return blob;
  }

  function remember(link) {
    var list = [];
    try { list = JSON.parse(Sahra.store.get("sahra_tickets") || "[]"); } catch (e) { list = []; }
    if (!Array.isArray(list)) list = [];
    list = list.filter(function (x) { return x && x.link !== link; });
    list.unshift({ party: party, link: link, at: Date.now() });
    Sahra.store.set("sahra_tickets", JSON.stringify(list.slice(0, 20)));
  }

  function closedReason() {
    if (!data) return null;
    if (!data.turnstile_site_key) return t("closed_unavailable");
    if (data.full) return t("closed_full");
    if (data.registration.state === "not_open_yet") return t("closed_not_yet", { when: Sahra.when(data.registration.opens_at, tz()) });
    if (data.registration.state === "closed") return t("closed_over");
    if (data.types.length && !data.types.some(function (x) { return x.on_sale; })) return t("closed_unavailable");
    return null;
  }
  function tz() { return data && data.details ? data.details.time_zone : null; }

  // ------------------------------------------------------------ sections

  function partyCard() {
    var d = data.details || {};
    var timeLine = d.starts_at ? Sahra.when(d.starts_at, d.time_zone) + (d.ends_at ? " - " + Sahra.time(d.ends_at, d.time_zone) : "") : null;
    return el("section", null,
      el("h1", { text: data.party.name, attrs: { dir: "auto" } }),
      timeLine ? el("p", { class: "muted", text: timeLine }) : null,
      d.description ? el("p", { class: "pre", text: d.description, attrs: { dir: "auto" } }) : null);
  }

  function addressCard() {
    var d = data.details;
    if (!d) return null;
    var body;
    if (d.address || d.venue_name) {
      body = [d.venue_name ? el("p", { text: d.venue_name, attrs: { dir: "auto" } }) : null, d.address ? el("p", { class: "pre", text: d.address, attrs: { dir: "auto" } }) : null,
        d.map_url ? el("a", { text: t("open_map"), attrs: { href: d.map_url, rel: "noopener", target: "_blank" } }) : null];
    } else if (d.reveal && d.reveal.mode === "at_time" && d.reveal.at) {
      body = el("p", { text: t("addr_at_time", { rel: Sahra.rel(d.reveal.at) }) });
    } else if (d.reveal && d.reveal.mode === "manual") {
      body = el("p", { text: t("addr_manual") });
    } else {
      body = el("p", { text: t("addr_with_ticket") });
    }
    return el("section", { class: "card" }, el("p", { class: "small muted", text: t("where") }), body);
  }

  function rulesCard() {
    var d = data.details;
    if (!d || !d.rules) return null;
    return el("section", { class: "card" }, el("p", { class: "small muted", text: t("rules") }), el("p", { class: "pre", text: d.rules, attrs: { dir: "auto" } }));
  }

  function typeStatus(x) {
    if (x.sold_out) return el("span", { class: "pill no", text: t("sold_out") });
    if (!x.on_sale) {
      if (x.sales_opens_at && x.sales_opens_at > Date.now()) return el("span", { class: "pill", text: t("opens_rel", { rel: Sahra.rel(x.sales_opens_at) }) });
      return el("span", { class: "pill", text: t("not_on_sale") });
    }
    var bits = [];
    if (x.sales_closes_at) bits.push(t("closes_rel", { rel: Sahra.rel(x.sales_closes_at) }));
    if (x.places_left <= 20) bits.push(t("left_n", { n: x.places_left }));
    return bits.length ? el("span", { class: "small muted", text: bits.join(" · ") }) : null;
  }

  function typesBlock(form) {
    if (!data.types.length) return null;
    return el("fieldset", { class: "field", attrs: { "aria-label": t("choose_type") } },
      el("p", { class: "label", text: t("choose_type") }),
      data.types.map(function (x) {
        var input = el("input", { attrs: { type: "radio", name: "type_id", value: x.id, disabled: !x.on_sale, required: true } });
        input.addEventListener("change", function () { paymentRefresh(form); });
        return el("label", { class: "choice" + (x.on_sale ? "" : " off") }, input,
          el("span", { class: "grow" },
            el("span", { class: "row" }, el("strong", { text: x.name, attrs: { dir: "auto" } }), el("span", { class: "price", text: x.price ? Sahra.money(x.price) + " " + t("per_person") : t("free") })),
            x.description ? el("span", { class: "small muted pre", text: x.description, attrs: { dir: "auto" } }) : null,
            el("span", null, typeStatus(x))));
      }));
  }

  function questionField(q) {
    var input;
    if (q.type === "choice") {
      input = el("select", { attrs: { required: q.required } }, el("option", { text: "", attrs: { value: "" } }),
        q.options.map(function (o) { return el("option", { text: o, attrs: { value: o } }); }));
    } else if (q.type === "long") {
      input = el("textarea", { attrs: { maxlength: 500, required: q.required } });
    } else if (q.type === "yesno") {
      input = el("input", { attrs: { type: "checkbox" } });
      input.dataset.q = q.id;
      input.dataset.kind = "yesno";
      return el("div", { class: "field" }, el("label", { class: "check" }, input, el("span", { text: q.label, attrs: { dir: "auto" } })));
    } else {
      input = el("input", { attrs: { type: "text", maxlength: 500, required: q.required } });
    }
    input.dataset.q = q.id;
    return el("div", { class: "field" },
      el("label", null, el("span", { text: q.label, attrs: { dir: "auto" } }), q.required ? "" : " (" + t("optional") + ")", input));
  }

  // Payment instructions and the total follow the chosen ticket and the number of people.
  function paymentRefresh(form) {
    var box = form.querySelector("[data-pay]");
    if (!box) return;
    var chosen = form.querySelector("input[name=type_id]:checked");
    var type = chosen ? data.types.filter(function (x) { return x.id === chosen.value; })[0] : null;
    var how = type ? type.payment_instructions : data.payment_instructions;
    var people = Math.max(1, Number(form.elements.people.value) || 1);
    Sahra.clear(box);
    if (type && type.price) box.appendChild(el("p", { class: "price", text: t("total_due", { amount: Sahra.money(type.price * people) }) }));
    if (how) box.appendChild(el("p", { class: "pre", text: how, attrs: { dir: "auto" } }));
    box.hidden = !box.firstChild;
  }

  function formBlock() {
    var shot = data.form.screenshot;
    var maxPeople = data.max_people_per_ticket;
    var draft = {};
    try { draft = JSON.parse(sessionStorage.getItem(draftKey) || "{}"); } catch (e) { draft = {}; }
    var people = el("input", { attrs: { type: "number", name: "people", min: 1, max: maxPeople, value: draft.people || 1, inputmode: "numeric", required: true } });
    var typesSlot = el("div");
    var form = el("form", null,
      typesSlot,
      el("h2", { text: t("your_details") }),
      el("div", { class: "field" }, el("label", null, t("full_name"),
        el("input", { attrs: { type: "text", name: "name", maxlength: 80, required: true, autocomplete: "name", value: draft.name || "" } }))),
      el("div", { class: "field" }, el("label", null, t("email"),
        el("input", { attrs: { type: "email", name: "email", maxlength: 254, required: true, autocomplete: "email", inputmode: "email", value: draft.email || "" } }),
        el("span", { class: "hint", text: t("email_hint") }))),
      el("div", { class: "field", hidden: maxPeople <= 1 }, el("label", null, t("people"), people,
        el("span", { class: "hint", text: t("people_hint", { n: maxPeople }) }))),
      data.form.questions.map(questionField),
      shot === "none" ? null : el("div", null,
        el("h2", { text: t("how_to_pay") }),
        el("div", { class: "card", attrs: { "data-pay": "" } }),
        el("div", { class: "field" }, el("label", null, t("screenshot") + (shot === "required" ? "" : " (" + t("optional") + ")"),
          el("input", { attrs: { type: "file", name: "screenshot", accept: "image/jpeg,image/png,image/webp", required: shot === "required" } }),
          el("span", { class: "hint", text: t("screenshot_hint") + " " + t("screenshot_size") })))),
      el("div", { attrs: { id: "turnstile-signup" } }),
      el("div", { class: "spacer" }),
      el("button", { class: "btn primary", text: t("request_ticket"), attrs: { type: "submit" } }),
      el("div", { attrs: { role: "status", "aria-live": "polite", "data-result": "" } }));
    // The ticket choices need the form for their change handler; the first one on sale is chosen.
    if (data.types.length) {
      typesSlot.appendChild(typesBlock(form));
      var first = data.types.filter(function (x) { return x.on_sale; })[0];
      if (first) form.querySelector("input[value='" + first.id + "']").checked = true;
    }
    people.addEventListener("input", function () { paymentRefresh(form); });
    form.addEventListener("submit", submit);
    setTimeout(function () { paymentRefresh(form); }, 0);
    return form;
  }

  function lostLinkBlock() {
    var out = el("div", { attrs: { role: "status", "aria-live": "polite" } });
    var f = el("form", null,
      el("p", { class: "muted", text: t("lost_text") }),
      el("div", { class: "field" }, el("label", null, t("email"),
        el("input", { attrs: { type: "email", name: "email", maxlength: 254, required: true, inputmode: "email", autocomplete: "email" } }))),
      el("div", { attrs: { id: "turnstile-resend" } }),
      el("div", { class: "spacer" }),
      el("button", { class: "btn", text: t("send_link"), attrs: { type: "submit" } }),
      out);
    f.addEventListener("submit", async function (e) {
      e.preventDefault();
      var btn = f.querySelector("button");
      btn.disabled = true;
      var r = await Sahra.api.post("/api/guest/parties/" + encodeURIComponent(party) + "/resend",
        { email: f.elements.email.value, turnstile: window.turnstile ? window.turnstile.getResponse(widgets.resend) || "" : "" });
      if (window.turnstile && widgets.resend !== undefined) window.turnstile.reset(widgets.resend);
      btn.disabled = false;
      Sahra.clear(out).appendChild(el("p", { class: "notice " + (r.ok ? "yes" : "no"), text: r.ok ? t("link_on_way") : Sahra.errorText(r) }));
    });
    var box = el("details", null, el("summary", { text: t("lost_title") }), f);
    box.addEventListener("toggle", function () { if (box.open) mountTurnstile(); });
    return el("section", null, box);
  }

  function doneView() {
    var url = location.origin + done.link;
    var copy = el("button", { class: "btn", text: t("copy"), attrs: { type: "button" } });
    copy.addEventListener("click", async function () {
      try { await navigator.clipboard.writeText(url); copy.textContent = t("copied"); } catch (e) { /* the link is shown below to copy by hand */ }
    });
    return el("section", null,
      el("h1", { text: t("done_title") }),
      el("p", { text: t("done_text") }),
      done.earlier > 0 ? el("p", { class: "notice maybe", text: t("earlier_n", { n: done.earlier }) }) : null,
      el("a", { class: "btn primary", text: t("open_ticket"), attrs: { href: done.link } }),
      copy,
      el("p", { class: "small muted pre", text: url }),
      el("p", { class: "small muted", text: t("device_note") }));
  }

  // ------------------------------------------------------------ render

  function render() {
    // A language switch after the page is built reloads it (the bot-check widgets
    // cannot be moved); what was typed is kept for this tab.
    if (built) {
      saveDraft();
      location.reload();
      return;
    }
    built = true;
    Sahra.clear(app);
    document.title = data && data.party ? data.party.name + " - Sahra" : "Sahra";
    if (loadError) { app.appendChild(el("p", { class: "notice no", text: loadError })); return; }
    if (done) { app.appendChild(doneView()); return; }
    // Phones: one column. Desktop: the party on the side, the form beside it.
    var body = el("div");
    app.appendChild(el("div", { class: "cols" }, el("div", { class: "side" }, partyCard(), addressCard(), rulesCard()), body));
    var closed = closedReason();
    if (closed) {
      body.appendChild(el("p", { class: "notice maybe", text: closed }));
    } else {
      var notes = [];
      if (data.registration.closes_at) notes.push(t("closes_at", { when: Sahra.when(data.registration.closes_at, tz()) }));
      if (data.max_tickets_per_email) notes.push(t("max_per_email", { n: data.max_tickets_per_email }));
      if (notes.length) body.appendChild(el("p", { class: "small muted", text: notes.join(" ") }));
      body.appendChild(formBlock());
    }
    if (data.turnstile_site_key) body.appendChild(lostLinkBlock());
    mountTurnstile();
  }

  function saveDraft() {
    var f = app.querySelector("form");
    if (!f || !f.elements.name) return;
    try {
      sessionStorage.setItem(draftKey, JSON.stringify({ name: f.elements.name.value, email: f.elements.email.value, people: f.elements.people.value }));
    } catch (e) { /* not kept */ }
  }

  window.sahraTurnstileReady = function () { turnstileReady = true; mountTurnstile(); };
  function mountTurnstile() {
    if (!turnstileReady || !data || !data.turnstile_site_key || !window.turnstile) return;
    [["signup", "#turnstile-signup"], ["resend", "#turnstile-resend"]].forEach(function (w) {
      var at = document.querySelector(w[1]);
      // A closed "Lost your ticket link?" box gets its widget when it is opened.
      if (widgets[w[0]] === undefined && at && at.offsetParent !== null) {
        widgets[w[0]] = window.turnstile.render(w[1], { sitekey: data.turnstile_site_key, language: Sahra.lang() });
      }
    });
  }

  // ------------------------------------------------------------ submit

  async function submit(e) {
    e.preventDefault();
    var f = e.target;
    var out = f.querySelector("[data-result]");
    var btn = f.querySelector("button[type=submit]");
    var say = function (cls, text) { Sahra.clear(out).appendChild(el("p", { class: "notice " + cls, text: text })); };
    var token = Sahra.store.get(tokenKey) || Sahra.token();
    Sahra.store.set(tokenKey, token);
    var answers = {};
    f.querySelectorAll("[data-q]").forEach(function (x) {
      if (x.dataset.kind === "yesno") { if (x.checked) answers[x.dataset.q] = "yes"; }
      else if (x.value.trim()) answers[x.dataset.q] = x.value;
    });
    var fd = new FormData();
    fd.set("signup", token);
    fd.set("name", f.elements.name.value);
    fd.set("email", f.elements.email.value);
    fd.set("people", f.elements.people.value || "1");
    var chosen = f.querySelector("input[name=type_id]:checked");
    if (chosen) fd.set("type_id", chosen.value);
    fd.set("answers", JSON.stringify(answers));
    fd.set("cf-turnstile-response", window.turnstile ? window.turnstile.getResponse(widgets.signup) || "" : "");
    btn.disabled = true;
    btn.textContent = t("sending");
    try {
      var file = f.elements.screenshot && f.elements.screenshot.files[0];
      if (file) {
        var shot = await compress(file);
        fd.set("screenshot", shot, shot === file ? file.name : "screenshot.jpg");
      }
    } catch (err) {
      btn.disabled = false;
      btn.textContent = t("request_ticket");
      return say("no", t("e_screenshot_must_be_jpeg_png_or_webp"));
    }
    var r = await Sahra.api.post("/api/guest/parties/" + encodeURIComponent(party) + "/signup", fd);
    if (window.turnstile && widgets.signup !== undefined) window.turnstile.reset(widgets.signup);
    btn.disabled = false;
    btn.textContent = t("request_ticket");
    if (r.ok && r.body.link) {
      Sahra.store.del(tokenKey);
      try { sessionStorage.removeItem(draftKey); } catch (x) { /* nothing kept */ }
      remember(r.body.link);
      done = { link: r.body.link, earlier: r.body.earlier_requests || 0 };
      built = false;
      render();
      window.scrollTo(0, 0);
      return;
    }
    // "Pending": stored but not yet confirmed; the same token finishes it. Kept for every other answer too
    // (a retry with the same token can never make a second ticket).
    say(r.body && r.body.status === "pending" ? "maybe" : "no", r.body && r.body.status === "pending" ? t("not_confirmed") : Sahra.errorText(r));
  }

  // ------------------------------------------------------------ start

  (async function () {
    if (!/^[a-z0-9-]{3,24}$/.test(party)) loadError = t("party_missing");
    else {
      var r = await Sahra.api.get("/api/guest/parties/" + encodeURIComponent(party));
      if (r.status === 404) loadError = t("party_missing");
      else if (!r.ok) loadError = Sahra.errorText(r);
      else data = r.body;
    }
    Sahra.boot({ render: render });
  })();
})();
