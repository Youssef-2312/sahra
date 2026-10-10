// Guest sign-up page: /signup.html?party=<id>. Order (owner, brainstorm idea 2):
// party name, date and time; address status; ticket types with prices; a short
// form. The sign-up token is created once and kept until the request is
// confirmed, so a retry after "not confirmed yet" is the same request, never a
// second ticket. A confirmed ticket link is remembered in this browser
// (sahra_tickets) for the home page.
//
// Above the button: the privacy notice and the required Terms box (and the
// party's entry rules and cancellation policy, whichever it has). The box starts unticked and is never
// remembered; the server checks it and records the versions the form showed
// (data.policy). If they changed meanwhile, the form stays as typed and asks the
// guest to review and tick again.
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
  var policy = null;      // data.policy: the versions this form shows (src/guests/policy.ts)
  var acceptEl = null;    // the notice and Terms box, see acceptBlock()

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
    if (data.registration.cancelled) return t("closed_cancelled") + (data.details && data.details.cancelled && data.details.cancelled.reason ? " " + data.details.cancelled.reason : "");
    if (data.registration.needs_contact) return t("closed_contact");
    if (data.registration.state === "not_open_yet") return t("closed_not_yet", { when: Sahra.when(data.registration.opens_at, tz()) });
    if (data.registration.state === "closed") return t("closed_over");
    if (data.types.length && !data.types.some(function (x) { return x.on_sale; })) return t("closed_unavailable");
    return null;
  }
  function tz() { return data && data.details ? data.details.time_zone : null; }

  // ------------------------------------------------------------ sections

  // The party: its pictures (a large one and thumbnails to switch), the name, and
  // when / where / price at a glance.
  function gallery() {
    var pics = data.flyers || [];
    if (!pics.length) return null;
    var main = el("img", { attrs: { src: pics[0].url, alt: "", decoding: "async" } });
    var thumbs = null;
    if (pics.length > 1) {
      thumbs = el("div", { class: "thumbs" }, pics.map(function (p, i) {
        var b = el("button", { class: "thumb" + (i === 0 ? " on" : ""),
          attrs: { type: "button", "aria-label": t("pic_n", { n: i + 1, of: pics.length }), "aria-pressed": i === 0 ? "true" : "false" } },
          el("img", { attrs: { src: p.url, alt: "", loading: "lazy", decoding: "async" } }));
        b.addEventListener("click", function () {
          main.src = p.url;
          thumbs.querySelectorAll(".thumb").forEach(function (x) { x.classList.toggle("on", x === b); x.setAttribute("aria-pressed", x === b ? "true" : "false"); });
        });
        return b;
      }));
    }
    return el("div", { class: "gallery" }, el("div", { class: "main-pic" }, main), thumbs);
  }
  function priceFact() {
    var sale = data.types.filter(function (x) { return x.on_sale; });
    if (!sale.length) return null;
    var prices = sale.map(function (x) { return x.price || 0; });
    var low = Math.min.apply(null, prices);
    var many = prices.some(function (p) { return p !== low; });
    if (!low && !many) return t("free");
    return t(many ? "from_pp" : "price_pp", { amount: Sahra.money(low) });
  }
  function whereFact(d) {
    if (d.venue_name || d.address) return d.venue_name || d.address.split("\n")[0];
    if (d.reveal && d.reveal.mode === "at_time" && d.reveal.at) return t("addr_at_time", { rel: Sahra.rel(d.reveal.at) });
    return t("where_later");
  }
  function partyCard() {
    var d = data.details || {};
    var timeLine = d.starts_at ? Sahra.when(d.starts_at, d.time_zone) + (d.ends_at ? " - " + Sahra.time(d.ends_at, d.time_zone) : "") : null;
    var price = priceFact();
    var fact = function (k, v) { return v ? el("li", null, el("span", { class: "k", text: t(k) }), el("span", { class: "v", text: v, attrs: { dir: "auto" } })) : null; };
    var pics = gallery();
    return el("section", { class: "buy-hero" + (pics ? "" : " no-pic") }, pics,
      el("div", { class: "buy-head" },
        el("p", { class: "label-line", text: t("buy_label") }),
        el("h1", { text: data.party.name, attrs: { dir: "auto" } }),
        el("ul", { class: "facts" }, fact("fact_when", timeLine), fact("where", data.details ? whereFact(d) : null), fact("fact_price", price)),
        // How a ticket works here, in three words each (the home page's steps).
        el("ol", { class: "mini-steps" }, [1, 2, 3].map(function (n) {
          return el("li", null, el("span", { class: "n", text: String(n), attrs: { "aria-hidden": "true" } }), t("h_step" + n + "_t"));
        }))),
      // Its own block: on desktop under the picture (owner: a long description left a big gap there), on phones after the facts.
      d.description ? el("p", { class: "desc pre buy-desc", text: d.description, attrs: { dir: "auto" } }) : null);
  }

  // Desktop: beside the form, kept in view. The order follows the form as it changes.
  function orderCard() {
    var row = function (k, attr) { return el("div", { class: "row" }, el("dt", { text: t(k) }), el("dd", { attrs: attr })); };
    return el("section", { class: "card order", attrs: { "aria-live": "polite" } },
      el("h2", { text: t("your_order") }),
      el("dl", null, row("order_ticket", { "data-o-type": "" }), row("order_count", { "data-o-count": "" }), row("order_people", { "data-o-people": "" }), row("order_each", { "data-o-each": "" })),
      el("div", { class: "total" }, el("span", { text: t("order_total") }), el("span", { attrs: { "data-o-total": "" } })),
      el("p", { class: "small muted", text: t("order_after") }));
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

  // Always in the page (hidden when empty), so new texts from a "terms changed" answer can be shown in place.
  // texts: what this form shows and the guest agrees to; updated from that answer.
  var texts = { rules: null, cancellation: null };
  function textCard(id, title, value) {
    var card = el("section", { class: "card", attrs: { id: id, tabindex: "-1" } });
    textFill(card, title, value);
    return card;
  }
  function textFill(card, title, value) {
    Sahra.clear(card);
    card.hidden = !value;
    if (value) card.append(el("p", { class: "small muted", text: t(title) }), el("p", { class: "pre", text: value, attrs: { dir: "auto" } }));
  }
  function rulesCard() {
    var d = data.details || {};
    texts = { rules: d.rules || null, cancellation: d.cancellation_policy || null };
    return [textCard("party-rules", "rules", texts.rules), textCard("party-cancel", "cancel_title", texts.cancellation)];
  }

  // The privacy notice (information, not a consent) and the Terms box, kept apart.
  // Policy pages open in a new tab so nothing typed or chosen here is lost.
  function newTab(text, href) { return el("a", { text: text, attrs: { href: href, target: "_blank", rel: "noopener" } }); }
  function acceptBlock() {
    var notice = el("p", { class: "form-notice", attrs: { id: "privacy-notice" } });
    var box = el("input", { attrs: { type: "checkbox", name: "accept_terms", value: "yes", required: true, autocomplete: "off", "aria-describedby": "accept-error" } });
    var text = el("span");
    var err = el("p", { class: "field-error", attrs: { id: "accept-error", role: "alert" } });
    err.hidden = true;
    function validity() { box.setCustomValidity(box.checked ? "" : t("e_terms_not_accepted")); }
    function fill() {
      Sahra.clear(notice);
      var withId = /\+id$/.test(policy.privacy_version);
      notice.append(t(withId ? "pn_text_id" : "pn_text") + (policy.email ? " " + t("pn_email") : "") + " " + t("pn_read"), newTab(t("pn_link"), "/privacy"), t("pn_end"));
      Sahra.clear(text);
      text.append(t("acc_a"), newTab(t("acc_terms"), "/terms"));
      // Only what the page actually shows: the entry rules and/or the cancellation policy.
      var parts = [];
      if (texts.rules) parts.push(el("a", { text: t("acc_rules"), attrs: { href: "#party-rules" } }));
      if (texts.cancellation) parts.push(el("a", { text: t("acc_cancel"), attrs: { href: "#party-cancel" } }));
      if (parts.length) {
        text.append(t("acc_b"), parts[0]);
        if (parts[1]) text.append(t("acc_and"), parts[1]);
        text.append(t("acc_party"));
      }
      text.append(t("acc_end"));
      validity();
    }
    box.addEventListener("change", function () { validity(); if (box.checked) err.hidden = true; });
    box.addEventListener("invalid", function () { err.textContent = t("e_terms_not_accepted"); err.hidden = false; });
    fill();
    var wrap = el("div", { class: "accept-block" }, notice, el("label", { class: "check accept" }, box, text), err);
    // The server refused: untick, show what applies now and why.
    wrap.refresh = function (msg) {
      box.checked = false;
      fill();
      err.textContent = msg;
      err.hidden = false;
      box.focus();
    };
    return wrap;
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
    return el("fieldset", { class: "field types", attrs: { "aria-label": t("choose_type") } },
      data.types.map(function (x) {
        var input = el("input", { attrs: { type: "radio", name: "type_id", value: x.id, disabled: !x.on_sale, required: true } });
        input.addEventListener("change", function () { paymentRefresh(form); });
        return el("label", { class: "choice" + (x.on_sale ? "" : " off") }, input,
          el("span", { class: "grow" },
            el("span", { class: "row" }, el("strong", { text: x.name, attrs: { dir: "auto" } }), el("span", { class: "price", text: x.price ? Sahra.money(x.price) + " " + priceUnit(x) : t("free") })),
            el("span", { class: "small muted", text: peopleText(x) }),
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
  // A type of a fixed group size (Duo: exactly 2) is priced as a package: its price
  // is for the whole ticket. Other types are priced per person.
  function isPackage(x) { return !!x.package; }
  function priceUnit(x) { return isPackage(x) ? t("per_package", { n: x.min_people }) : t("per_person"); }
  function ticketPrice(x, people) { return (x.price || 0) * (isPackage(x) ? 1 : people); }

  function paymentRefresh(form) {
    var box = form.querySelector("[data-pay]");
    if (!box) return;
    var chosen = form.querySelector("input[name=type_id]:checked");
    var type = chosen ? data.types.filter(function (x) { return x.id === chosen.value; })[0] : null;
    var how = type ? type.payment_instructions : data.payment_instructions;
    var people = Math.max(1, Number(form.elements.people.value) || 1), n = Math.max(1, Number(form.elements.tickets.value) || 1);
    Sahra.clear(box);
    if (type && type.price) box.appendChild(el("p", { class: "price", text: t("total_due", { amount: Sahra.money(ticketPrice(type, people) * n) }) }));
    if (how) box.appendChild(el("p", { class: "pre", text: how, attrs: { dir: "auto" } }));
    box.hidden = !box.firstChild;
  }
  function orderRefresh(form) {
    var chosen = form.querySelector("input[name=type_id]:checked");
    var type = chosen ? data.types.filter(function (x) { return x.id === chosen.value; })[0] : null;
    var people = Math.max(1, Number(form.elements.people.value) || 1);
    var n = Math.max(1, Number(form.elements.tickets.value) || 1);
    var set = function (k, v) { var x = document.querySelector("[data-o-" + k + "]"); if (x) { x.textContent = v; x.parentElement.hidden = v === null; } };
    set("type", type ? type.name : null);
    set("count", String(n));
    set("people", people > 1 ? String(people) : null);
    set("each", type ? Sahra.money(type.price) : null);
    var each = document.querySelector("[data-o-each]");
    if (each) each.parentElement.firstChild.textContent = t(type && isPackage(type) ? "order_each_package" : "order_each");
    var total = document.querySelector("[data-o-total]");
    if (total) total.textContent = type ? Sahra.money(ticketPrice(type, people) * n) : "-";
  }

  // The payment screenshot: a large target with the chosen photo's name and preview
  // (the real file input stays in the form, focusable, for the browser's checks).
  function uploadField(ask, o) {
    o = o || { name: "screenshot", id: "shot-file", label: t("screenshot"), hint: t("screenshot_hint") + " " + t("screenshot_size") };
    var input = el("input", { class: "sr-file", attrs: { type: "file", id: o.id, name: o.name, accept: "image/jpeg,image/png,image/webp", required: ask === "required" } });
    var name = el("span", { class: "up-name", text: t("up_none") });
    var action = el("strong", { text: t("up_choose") });
    var thumb = el("img", { class: "up-thumb", attrs: { alt: "" } });
    thumb.hidden = true;
    input.addEventListener("change", function () {
      var f = input.files && input.files[0];
      name.textContent = f ? f.name : t("up_none");
      action.textContent = t(f ? "up_change" : "up_choose");
      thumb.hidden = true;
      if (f && /^image\//.test(f.type) && f.size < 15e6 && window.FileReader) {
        var r = new FileReader();
        r.onload = function () { thumb.src = r.result; thumb.hidden = false; };
        r.readAsDataURL(f);
      }
    });
    return el("div", { class: "field upload-field" },
      el("p", { class: "label", text: o.label + (ask === "required" ? "" : " (" + t("optional") + ")") }),
      input,
      el("label", { class: "upload", attrs: { for: o.id } }, thumb, el("span", { class: "up-text" }, action, name)),
      el("span", { class: "hint", text: o.hint }));
  }

  // The party's form can ask for an Instagram handle and an ID photo (none / optional / required).
  function instagramField(ask, draft) {
    if (ask === "none") return null;
    return el("div", { class: "field" }, el("label", null, t("insta_label") + (ask === "required" ? "" : " (" + t("optional") + ")"),
      el("input", { attrs: { type: "text", name: "instagram", maxlength: 100, required: ask === "required", autocomplete: "off",
        autocapitalize: "none", spellcheck: "false", inputmode: "text", dir: "ltr", placeholder: "@", value: draft.instagram || "" } }),
      el("span", { class: "hint", text: t("insta_hint") })));
  }
  function idPhotoField(ask) {
    if (ask === "none") return null;
    return uploadField(ask, { name: "id_photo", id: "id-file", label: t("id_label"), hint: t("id_hint") });
  }

  // Two steppers (owner): Quantity = how many separate tickets (each its own QR code,
  // for friends who arrive on their own; migrations/0022), and, for group types,
  // People on this ticket (one QR code admits them together). The people limits are
  // the chosen type's (a group type, a single one) or the party's; exactly one hides it.
  var MAX_TICKETS = 10;
  function peopleRange(type) {
    return type ? { min: type.min_people || 1, max: type.max_people || data.max_people_per_ticket } : { min: 1, max: data.max_people_per_ticket };
  }
  function quantityField(people, label, hintFor) {
    var minus = el("button", { class: "qty-btn", text: "\u2212", attrs: { type: "button", "aria-label": t("qty_less") } });
    var plus = el("button", { class: "qty-btn", text: "+", attrs: { type: "button", "aria-label": t("qty_more") } });
    var hint = el("span", { class: "hint" });
    var range = { min: 1, max: 1 };
    var field = el("div", { class: "field qty-field" },
      el("label", { text: label, attrs: { for: people.id } }), el("div", { class: "qty" }, minus, people, plus), hint);
    function set(n) {
      var v = Math.max(range.min, Math.min(range.max, n || range.min));
      people.value = String(v);
      minus.disabled = v <= range.min;
      plus.disabled = v >= range.max;
      people.dispatchEvent(new Event("input", { bubbles: true }));
    }
    field.bounds = function (r) {
      range = r;
      people.min = r.min;
      people.max = r.max;
      field.hidden = r.max <= 1;
      hint.textContent = hintFor(r);
      set(Number(people.value));
    };
    minus.addEventListener("click", function () { set(Number(people.value) - 1); });
    plus.addEventListener("click", function () { set(Number(people.value) + 1); });
    people.addEventListener("change", function () { set(Number(people.value)); });
    return field;
  }
  function peopleText(type) {
    var r = peopleRange(type);
    if (r.max <= 1) return t("one_person");
    if (r.min === r.max) return t("people_package", { n: r.max });
    return r.min > 1 ? t("people_range", { min: r.min, max: r.max }) : t("people_upto", { n: r.max });
  }

  function step(title, children) {
    return el("section", { class: "step" }, el("h2", { class: "step-title" }, el("span", { class: "num", attrs: { "aria-hidden": "true" } }), title), children);
  }

  function formBlock() {
    var shot = data.form.screenshot;
    var maxPeople = data.max_people_per_ticket;
    var draft = {};
    try { draft = JSON.parse(sessionStorage.getItem(draftKey) || "{}"); } catch (e) { draft = {}; }
    var people = el("input", { class: "qty-input", attrs: { type: "number", id: "qty-input", name: "people", min: 1, max: maxPeople, value: draft.people || 1, inputmode: "numeric", required: true } });
    var qty = quantityField(people, t("people_label"), function (r) {
      return r.min > 1 ? t("people_hint_range", { min: r.min, max: r.max }) : t("people_hint", { n: r.max });
    });
    var count = el("input", { class: "qty-input", attrs: { type: "number", id: "tickets-input", name: "tickets", min: 1, max: MAX_TICKETS, value: 1, inputmode: "numeric", required: true } });
    var tickets = quantityField(count, t("qty_label"), function () { return t("tickets_hint"); });
    var ticketMax = data.max_tickets_per_email ? Math.min(MAX_TICKETS, data.max_tickets_per_email) : MAX_TICKETS;
    // The names on the other tickets (optional; empty = the guest's own).
    var namesBox = el("div", { class: "names-box" });
    // When the party asks for an ID photo, each friend's ticket gets its own upload (kept across changes of the quantity).
    var idAsk = data.form.id_photo || "none";
    var friendUploads = {};
    function namesRefresh() {
      var n = Math.max(1, Number(count.value) || 1);
      var have = namesBox.querySelectorAll("input[data-friend]");
      var keep = [].map.call(have, function (x) { return x.value; });
      Sahra.clear(namesBox);
      if (n < 2) return;
      namesBox.appendChild(el("p", { class: "label", text: t("names_title") }));
      for (var i = 2; i <= n; i++) {
        var box = el("div", { class: "friend" }, el("div", { class: "field" }, el("label", null, t("name_on_ticket", { n: i }),
          el("input", { attrs: { type: "text", "data-friend": "", maxlength: 80, autocomplete: "off", dir: "auto", placeholder: t("name_optional"), value: keep[i - 2] || "" } }))));
        if (idAsk !== "none") {
          if (!friendUploads[i]) friendUploads[i] = uploadField(idAsk, { name: "id_photo_" + (i - 1), id: "id-file-" + i, label: t("id_label_n", { n: i }), hint: t("id_hint_friend") });
          box.appendChild(friendUploads[i]);
        }
        namesBox.appendChild(box);
      }
      namesBox.appendChild(el("p", { class: "hint", text: t("names_hint") }));
    }
    count.addEventListener("input", namesRefresh);
    var chosenType = function () {
      var c = form.querySelector("input[name=type_id]:checked");
      return c ? data.types.filter(function (x) { return x.id === c.value; })[0] || null : null;
    };
    var typesSlot = el("div");
    var form = el("form", { class: "buy-form" },
      data.types.length ? step(t("choose_type"), [typesSlot, tickets, qty]) : null,
      step(t("step_details"), [
      el("div", { class: "field" }, el("label", null, t("full_name"),
        el("input", { attrs: { type: "text", name: "name", maxlength: 80, required: true, autocomplete: "name", value: draft.name || "" } }))),
      el("div", { class: "field" }, el("label", null, t("email"),
        el("input", { attrs: { type: "email", name: "email", maxlength: 254, required: true, autocomplete: "email", inputmode: "email", value: draft.email || "" } }),
        el("span", { class: "hint", text: t("email_hint") }))),
      // No ticket types: the quantity sits with the details (people per ticket hidden when the party allows one).
      data.types.length ? null : tickets,
      data.types.length ? null : qty,
      namesBox,
      instagramField(data.form.instagram || "none", draft),
      idPhotoField(data.form.id_photo || "none"),
      data.form.questions.map(questionField)]),
      shot === "none" ? null : step(t("step_pay"), [
        el("div", { class: "pay-box", attrs: { "data-pay": "" } }),
        uploadField(shot)]),
      step(t("step_confirm"), [
        acceptEl = acceptBlock(),
        el("div", { attrs: { id: "turnstile-signup" } }),
        el("div", { class: "spacer" }),
        el("button", { class: "btn primary", text: t("request_ticket"), attrs: { type: "submit" } }),
        el("div", { attrs: { role: "status", "aria-live": "polite", "data-result": "" } })]));
    // The ticket choices need the form for their change handler; the first one on sale is chosen.
    if (data.types.length) {
      typesSlot.appendChild(typesBlock(form));
      var first = data.types.filter(function (x) { return x.on_sale; })[0];
      if (first) form.querySelector("input[value='" + first.id + "']").checked = true;
    }
    people.addEventListener("input", function () { paymentRefresh(form); orderRefresh(form); });
    count.addEventListener("input", function () { paymentRefresh(form); orderRefresh(form); });
    setTimeout(function () { tickets.bounds({ min: 1, max: ticketMax }); tickets.hidden = ticketMax <= 1; }, 0);
    form.addEventListener("change", function (e) {
      if (e.target && e.target.name === "type_id") qty.bounds(peopleRange(chosenType()));
      orderRefresh(form);
    });
    setTimeout(function () { qty.bounds(peopleRange(chosenType())); }, 0);
    form.addEventListener("submit", submit);
    setTimeout(function () { paymentRefresh(form); orderRefresh(form); }, 0);
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
    // Several tickets: one row each, to open or to copy and send to the friend it is for.
    var list = done.tickets && done.tickets.length > 1 ? el("ol", { class: "ticket-list" }, done.tickets.map(function (x, i) {
      var u = location.origin + x.link;
      var c = el("button", { class: "btn small-btn", text: t("copy"), attrs: { type: "button" } });
      c.addEventListener("click", async function () { try { await navigator.clipboard.writeText(u); c.textContent = t("copied"); } catch (e) { /* shown below */ } });
      return el("li", null,
        el("span", { class: "tl-text" }, el("strong", { text: i === 0 ? t("ticket_yours") : t("ticket_n", { n: i + 1 }) }),
          x.name ? el("span", { class: "muted", text: x.name, attrs: { dir: "auto" } }) : null,
          el("span", { class: "small faint mono", text: x.reference || Sahra.ref(x.ticket_id), attrs: { dir: "ltr" } })),
        el("span", { class: "tl-actions" }, el("a", { class: "btn small-btn", text: t("open_short"), attrs: { href: x.link } }), c));
    })) : null;
    return el("section", { class: "done-view" },
      el("h1", { text: t("done_title") }),
      el("p", { text: list ? t("done_text_n", { n: done.tickets.length }) : t("done_text") }),
      el("p", { class: "done-ref" }, el("span", { class: "small muted", text: t("ref_label") + " " }), el("strong", { text: done.reference || Sahra.ref(done.ticket_id), attrs: { dir: "ltr" } })),
      data && data.details && data.details.review_time ? el("p", { class: "small", text: t("review_time_line", { text: data.details.review_time }), attrs: { dir: "auto" } }) : null,
      done.earlier > 0 ? el("p", { class: "notice maybe", text: t("earlier_n", { n: done.earlier }) }) : null,
      list,
      list ? null : el("a", { class: "btn primary", text: t("open_ticket"), attrs: { href: done.link } }),
      list ? null : copy,
      list ? null : el("p", { class: "small muted pre", text: url }),
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
    Sahra.title(data && data.party ? data.party.name : null);
    if (loadError === "missing") {
      Sahra.title(t("nt_party_t"));
      app.appendChild(Sahra.problem({ kicker: t("nt_kicker_party"), title: t("nt_party_t"), text: t("party_missing"),
        actions: [[t("nt_home"), "/", true], [t("nt_find"), "/find"]] }));
      return;
    }
    if (loadError) { app.appendChild(el("p", { class: "notice no", text: loadError })); return; }
    if (done) { app.appendChild(doneView()); return; }
    // The party across the top; below it the form and, beside it on desktops, the
    // order with where, entry rules and cancellation (one column on phones).
    app.classList.add("buy");
    var body = el("div", { class: "buy-main" });
    var closed = closedReason();
    app.appendChild(partyCard());
    app.appendChild(el("div", { class: "buy-cols" }, body,
      el("aside", { class: "summary" }, closed ? null : orderCard(), addressCard(), rulesCard(), Sahra.contactCard(data.details && data.details.support))));
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
      sessionStorage.setItem(draftKey, JSON.stringify({ name: f.elements.name.value, email: f.elements.email.value, people: f.elements.people.value,
        instagram: f.elements.instagram ? f.elements.instagram.value : "" }));
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
    fd.set("tickets", f.elements.tickets.value || "1");
    var friends = [].map.call(f.querySelectorAll("[data-friend]"), function (x) { return x.value.trim(); });
    if (friends.length) fd.set("names", JSON.stringify(friends));
    var chosen = f.querySelector("input[name=type_id]:checked");
    if (chosen) fd.set("type_id", chosen.value);
    fd.set("answers", JSON.stringify(answers));
    fd.set("accept_terms", f.elements.accept_terms.checked ? "yes" : "");
    fd.set("terms_version", policy.terms_version);
    fd.set("privacy_version", policy.privacy_version);
    fd.set("rules_version", policy.rules_version || "");
    fd.set("cf-turnstile-response", window.turnstile ? window.turnstile.getResponse(widgets.signup) || "" : "");
    btn.disabled = true;
    btn.textContent = t("sending");
    if (f.elements.instagram) fd.set("instagram", f.elements.instagram.value);
    var which = "screenshot";
    try {
      var file = f.elements.screenshot && f.elements.screenshot.files[0];
      if (file) {
        var shot = await compress(file);
        fd.set("screenshot", shot, shot === file ? file.name : "screenshot.jpg");
      }
      which = "id_photo";
      var idFile = f.elements.id_photo && f.elements.id_photo.files[0];
      if (idFile) {
        var idSmall = await compress(idFile);
        fd.set("id_photo", idSmall, idSmall === idFile ? idFile.name : "id.jpg");
      }
      // Each friend's ID photo (only for the tickets in the order).
      var n = Math.max(1, Number(f.elements.tickets.value) || 1);
      for (var k = 1; k < n; k++) {
        var fi = f.elements["id_photo_" + k], ff = fi && fi.files && fi.files[0];
        if (!ff) continue;
        var small = await compress(ff);
        fd.set("id_photo_" + k, small, small === ff ? ff.name : "id" + k + ".jpg");
      }
    } catch (err) {
      btn.disabled = false;
      btn.textContent = t("request_ticket");
      return say("no", t("e_" + which + "_must_be_jpeg_png_or_webp"));
    }
    var r = await Sahra.api.post("/api/guest/parties/" + encodeURIComponent(party) + "/signup", fd);
    if (window.turnstile && widgets.signup !== undefined) window.turnstile.reset(widgets.signup);
    btn.disabled = false;
    btn.textContent = t("request_ticket");
    if (r.ok && r.body.link) {
      Sahra.store.del(tokenKey);
      try { sessionStorage.removeItem(draftKey); } catch (x) { /* nothing kept */ }
      var all = r.body.tickets && r.body.tickets.length ? r.body.tickets : [{ link: r.body.link, name: null }];
      all.slice().reverse().forEach(function (x) { remember(x.link); });
      done = { link: r.body.link, tickets: all, earlier: r.body.earlier_requests || 0, reference: r.body.reference, ticket_id: r.body.ticket_id };
      built = false;
      render();
      window.scrollTo(0, 0);
      return;
    }
    // Nothing stored; the form keeps what was typed and chosen.
    if (r.body && r.body.error === "terms_changed" && r.body.policy) {
      policy = r.body.policy;
      texts = { rules: r.body.rules || null, cancellation: r.body.cancellation_policy || null };
      textFill(document.getElementById("party-rules"), "rules", texts.rules);
      textFill(document.getElementById("party-cancel"), "cancel_title", texts.cancellation);
      Sahra.clear(out);
      acceptEl.refresh(t("e_terms_changed"));
      return;
    }
    if (r.body && r.body.error === "terms_not_accepted") {
      Sahra.clear(out);
      acceptEl.refresh(t("e_terms_not_accepted"));
      return;
    }
    // "Pending": stored but not yet confirmed; the same token finishes it. Kept for every other answer too
    // (a retry with the same token can never make a second ticket).
    say(r.body && r.body.status === "pending" ? "maybe" : "no", r.body && r.body.status === "pending" ? t("not_confirmed")
      : r.body && r.body.error === "id_photo_required" && r.body.ticket ? t("e_id_photo_required_n", { n: r.body.ticket }) : Sahra.errorText(r));
  }

  // ------------------------------------------------------------ start

  (async function () {
    if (!/^[a-z0-9-]{3,24}$/.test(party)) loadError = "missing";
    else {
      var r = await Sahra.api.get("/api/guest/parties/" + encodeURIComponent(party));
      if (r.status === 404) loadError = "missing";
      else if (!r.ok) loadError = Sahra.errorText(r);
      else {
        data = r.body;
        // An older server without versions: the request is then answered "terms_changed" with the current ones.
        policy = data.policy || { terms_version: "", privacy_version: "", rules_version: null, email: false };
      }
    }
    // Leaving the page (a policy link opened in this tab, say) keeps what was typed for this tab.
    window.addEventListener("pagehide", saveDraft);
    Sahra.boot({ render: render });
  })();
})();
