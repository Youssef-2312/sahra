// Party settings: /party.html (owner and admin). One card per part of the party,
// each saved on its own: basics, time, location, requests, rules and payment,
// pictures, ticket types, the guest form, and the guest emails. A side list jumps
// between them on wide screens.
//
// Every value is checked by the server (src/party/input.ts, src/guests/types.ts,
// src/guests/form.ts); a refused save shows the server's reason and keeps what
// was typed. Times are typed in the party's own time zone.
"use strict";
(function () {
  var t = Sahra.t, el = Sahra.el, S = SahraStaff;
  var party = null, types = null, form = null, flyers = null, loadErr = null;
  var nodes = {};          // section id -> its card
  var notes = {};          // section id -> [cls, text]: the answer shown after a rebuild
  var editing = null;      // the ticket type being edited: null, "new" or its id
  var preset = null;       // values a new type starts from
  var questions = null;    // the guest form's questions while being edited

  var ZONES = ["Africa/Cairo", "Asia/Dubai", "Asia/Riyadh", "Asia/Beirut", "Asia/Amman", "Europe/London", "Europe/Paris", "Europe/Berlin", "America/New_York", "UTC"];
  var MODES = [["public", "s_mode_public"], ["with_ticket", "s_mode_with_ticket"], ["at_time", "s_mode_at_time"], ["manual", "s_mode_manual"]];
  var ASKS = [["required", "s_ask_required"], ["optional", "s_ask_optional"], ["none", "s_ask_none"]];

  function val(f, name) { var v = f.elements[name].value; return typeof v === "string" ? v.trim() : v; }
  function textOrNull(f, name) { return val(f, name) || null; }
  function localOrNull(f, name) { return f.elements[name].value ? f.elements[name].value.slice(0, 16) : null; }
  function num(f, name) { return f.elements[name].value === "" ? null : Number(f.elements[name].value); }

  // ------------------------------------------------------------- loading

  async function load() {
    var rs = await Promise.all([Sahra.api.get("/api/party"), Sahra.api.get("/api/tickets/types"),
      Sahra.api.get("/api/tickets/form"), Sahra.api.get("/api/party/flyers")]);
    if (!rs[0].ok) { loadErr = rs[0]; return; }
    party = rs[0].body;
    types = rs[1].ok ? rs[1].body.types : [];
    form = rs[2].ok ? rs[2].body.form : null;
    flyers = rs[3].ok ? rs[3].body : { flyers: [], max: 8 };
  }

  /** Builds one card again (after a save), keeping its place and showing the answer. */
  function rebuild(id, note) {
    if (note) notes[id] = note;
    var old = nodes[id];
    var fresh = BUILD[id]();
    nodes[id] = fresh;
    if (old && old.parentNode) old.parentNode.replaceChild(fresh, old);
  }
  function noteFor(id) {
    var box = S.sayBox();
    if (notes[id]) { S.say(box, notes[id][0], notes[id][1]); delete notes[id]; }
    return box;
  }

  /** Saves some of the party's details; on success the card is drawn again from the saved values. */
  async function save(id, body, button, box) {
    button.disabled = true;
    S.say(box, "maybe", t("s_saving"));
    var r = await S.act("/api/party/details", body);
    button.disabled = false;
    if (!r.ok) { S.say(box, "no", S.why(r)); return false; }
    if (r.body.party) party = r.body.party;
    var text = t("s_saved");
    if (r.body.notices_queued) text += " " + S.tn("s_notices_queued", r.body.notices_queued);
    rebuild(id, ["yes", text]);
    return true;
  }

  function saveRow(label, box) {
    var b = el("button", { class: "btn primary small-btn", text: label || t("s_save"), attrs: { type: "submit" } });
    return { button: b, node: el("div", { class: "s-save" }, b, box) };
  }

  function formCard(id, title, intro, fields, collect) {
    var box = noteFor(id);
    var row = saveRow(null, box);
    var f = el("form", { attrs: { novalidate: true } }, fields, row.node);
    f.addEventListener("submit", function (e) {
      e.preventDefault();
      var body = collect(f, box);
      if (body) save(id, body, row.button, box);
    });
    return S.section(id, title, intro, f);
  }

  // ------------------------------------------------------------- the cards

  function basics() {
    return formCard("basics", t("s_basics"), t("s_basics_p"), [
      S.field(t("s_name"), S.input("name", "text", { maxlength: 80, required: true, value: party.name || "", dir: "auto" })),
      S.field(t("s_description"), textarea("description", party.description, 2000, 4), t("s_description_h")),
    ], function (f, box) {
      if (!val(f, "name")) { S.say(box, "no", t("s_name_needed")); return null; }
      return { name: val(f, "name"), description: textOrNull(f, "description") };
    });
  }

  function textarea(name, value, max, rows) {
    var a = el("textarea", { attrs: { name: name, maxlength: max, rows: rows || 3, dir: "auto" } });
    a.value = value || "";
    return a;
  }

  function zoneInput() {
    var list = el("datalist", { attrs: { id: "zones" } }, ZONES.map(function (z) { return el("option", { attrs: { value: z } }); }));
    var i = S.input("time_zone", "text", { list: "zones", value: party.time_zone || "Africa/Cairo", autocomplete: "off", spellcheck: "false", dir: "ltr" });
    return [i, list];
  }

  function notifyBox() {
    return S.check("notify_guests", t("s_notify"), false, t("s_notify_h"));
  }

  function time() {
    var tz = party.time_zone;
    var z = zoneInput();
    var zoneField = S.field(t("s_zone"), z[0], t("s_zone_h"));
    zoneField.appendChild(z[1]);
    return formCard("time", t("s_time"), t("s_time_p"), [
      zoneField,
      el("div", { class: "s-two" },
        S.field(t("s_starts"), S.input("starts_at_local", "datetime-local", { value: S.local(party.starts_at, tz) })),
        S.field(t("s_ends"), S.input("ends_at_local", "datetime-local", { value: S.local(party.ends_at, tz) }), t("s_ends_h"))),
      notifyBox(),
    ], function (f, box) {
      var body = { time_zone: val(f, "time_zone"), starts_at_local: localOrNull(f, "starts_at_local"), ends_at_local: localOrNull(f, "ends_at_local") };
      if (!body.time_zone) { S.say(box, "no", t("e_time_zone_required_for_local_times")); return null; }
      if (f.elements.notify_guests.checked) body.notify_guests = true;
      return body;
    });
  }

  /** What guests see of the place right now, in one line. */
  function placeState() {
    var p = party;
    if (p.address_mode === "public") return t("s_place_public");
    if (p.address_mode === "with_ticket") return t("s_place_with_ticket");
    if (p.address_mode === "at_time") return p.reveal_at ? t("s_place_at", { when: Sahra.when(p.reveal_at, p.time_zone) }) : t("s_place_at_unset");
    return p.revealed_at ? t("s_place_revealed", { when: Sahra.when(p.revealed_at, p.time_zone) }) : t("s_place_hidden");
  }

  function location() {
    var p = party, tz = p.time_zone, locked = !!p.address_locked;
    var modes = el("fieldset", { class: "s-modes" }, el("legend", { class: "label", text: t("s_mode") }),
      MODES.map(function (m) {
        var r = el("input", { attrs: { type: "radio", name: "address_mode", value: m[0] } });
        r.checked = p.address_mode === m[0];
        return el("label", { class: "choice" }, r, el("span", { class: "grow" }, el("strong", { text: t(m[1]) }), el("span", { class: "muted small", text: t(m[1] + "_h") })));
      }));
    var reveal = S.field(t("s_reveal_at"), S.input("reveal_at_local", "datetime-local", { value: S.local(p.reveal_at, tz) }), t("s_reveal_at_h"));
    var showReveal = function () { reveal.hidden = modes.querySelector("input:checked") === null || modes.querySelector("input:checked").value !== "at_time"; };
    modes.addEventListener("change", showReveal);
    showReveal();
    var lockValue = S.local(p.address_locked_at, tz);
    var fields = [
      el("p", { class: "s-state" }, el("span", { class: "pill " + (p.address_mode === "public" || p.revealed_at ? "yes" : "maybe"), text: t("s_now") }), " ", placeState()),
      locked ? el("p", { class: "notice maybe", text: t("s_locked", { when: Sahra.when(p.address_locked_at, tz) }) }) : null,
      S.field(t("s_venue"), S.input("venue_name", "text", { maxlength: 120, value: p.venue_name || "", disabled: locked, dir: "auto" })),
      S.field(t("s_address"), textarea("address", p.address, 300, 2)),
      S.field(t("s_map"), S.input("map_url", "url", { value: p.map_url || "", placeholder: "https://maps.app.goo.gl/...", dir: "ltr" }), t("s_map_h")),
      modes, reveal,
      S.field(t("s_lock"), S.input("address_locked_at_local", "datetime-local", { value: lockValue, disabled: locked }), t("s_lock_h")),
      notifyBox(),
    ];
    var card = formCard("location", t("s_location"), t("s_location_p"), fields, function (f) {
      var mode = f.querySelector("input[name=address_mode]:checked");
      var body = { time_zone: party.time_zone, address_mode: mode ? mode.value : party.address_mode,
        reveal_at_local: localOrNull(f, "reveal_at_local") };
      if (!locked) {
        body.venue_name = textOrNull(f, "venue_name");
        body.address = textOrNull(f, "address");
        body.map_url = textOrNull(f, "map_url");
        // Unchanged lock: not sent again (once passed, the server refuses any change to it).
        if ((f.elements.address_locked_at_local.value || "") !== lockValue) body.address_locked_at_local = localOrNull(f, "address_locked_at_local");
      }
      if (f.elements.notify_guests.checked) body.notify_guests = true;
      return body;
    });
    if (locked) card.querySelectorAll("textarea[name=address], input[name=map_url]").forEach(function (x) { x.disabled = true; });
    if (p.address_mode === "manual" && !p.revealed_at) {
      var box = S.sayBox();
      var b = el("button", { class: "btn small-btn", text: t("s_reveal_now"), attrs: { type: "button" } });
      b.addEventListener("click", async function () {
        if (!window.confirm(t("s_reveal_confirm"))) return;
        b.disabled = true;
        var r = await S.act("/api/party/reveal", {});
        b.disabled = false;
        if (!r.ok) { S.say(box, "no", S.why(r)); return; }
        var g = await Sahra.api.get("/api/party");
        if (g.ok) party = g.body;
        rebuild("location", ["yes", t("s_revealed_done")]);
      });
      card.appendChild(el("div", { class: "s-extra" }, el("p", { class: "muted small", text: t("s_reveal_now_h") }), b, box));
    }
    return card;
  }

  function requests() {
    var p = party, tz = p.time_zone;
    return formCard("requests", t("s_requests"), t("s_requests_p"), [
      el("div", { class: "s-two" },
        S.field(t("s_capacity"), S.input("capacity", "number", { min: 0, max: 100000, value: p.capacity, inputmode: "numeric" }), t("s_capacity_h")),
        S.field(t("s_people"), S.input("max_people_per_ticket", "number", { min: 1, max: 50, value: p.max_people_per_ticket, inputmode: "numeric" }), t("s_people_h"))),
      el("div", { class: "s-two" },
        S.field(t("s_opens"), S.input("registration_opens_at_local", "datetime-local", { value: S.local(p.registration_opens_at, tz) }), t("s_opens_h")),
        S.field(t("s_closes"), S.input("registration_closes_at_local", "datetime-local", { value: S.local(p.registration_closes_at, tz) }), t("s_closes_h"))),
      S.field(t("s_review_time"), S.input("review_time", "text", { maxlength: 80, value: p.review_time || "", dir: "auto" }), t("s_review_time_h")),
      S.field(t("s_per_email"), S.input("max_tickets_per_email", "number", { min: 1, max: 100, value: p.max_tickets_per_email === null ? "" : p.max_tickets_per_email, placeholder: t("s_no_limit"), inputmode: "numeric" }), t("s_per_email_h")),
    ], function (f, box) {
      if (f.elements.capacity.value === "" || f.elements.max_people_per_ticket.value === "") { S.say(box, "no", t("s_numbers_needed")); return null; }
      return { time_zone: party.time_zone, capacity: num(f, "capacity"), max_people_per_ticket: num(f, "max_people_per_ticket"),
        registration_opens_at_local: localOrNull(f, "registration_opens_at_local"), registration_closes_at_local: localOrNull(f, "registration_closes_at_local"),
        max_tickets_per_email: num(f, "max_tickets_per_email"), review_time: textOrNull(f, "review_time") };
    });
  }

  // The organiser's contact (brainstorm idea 16): a phone or WhatsApp number is required before requests open.
  function contact() {
    var p = party;
    var card = formCard("contact", t("s_contact"), t("s_contact_p"), [
      p.support_phone ? null : el("p", { class: "notice maybe", text: t("s_contact_missing") }),
      S.field(t("s_contact_phone"), S.input("support_phone", "tel", { maxlength: 30, value: p.support_phone || "", placeholder: "+20 100 000 0000", dir: "ltr", autocomplete: "tel" }), t("s_contact_phone_h")),
      el("div", { class: "s-two" },
        S.field(t("s_contact_email"), S.input("support_email", "email", { maxlength: 254, value: p.support_email || "", dir: "ltr" }), t("s_optional")),
        S.field(t("s_contact_note"), S.input("support_note", "text", { maxlength: 120, value: p.support_note || "", placeholder: t("s_contact_note_ph"), dir: "auto" }), t("s_optional"))),
    ], function (f, box) {
      var phone = val(f, "support_phone");
      if (!phone && party.support_phone && !window.confirm(t("s_contact_clear_confirm"))) return null;
      return { support_phone: phone || null, support_email: textOrNull(f, "support_email"), support_note: textOrNull(f, "support_note") };
    });
    return card;
  }

  function rules() {
    return formCard("rules", t("s_rules"), t("s_rules_p"), [
      S.field(t("s_entry_rules"), textarea("rules", party.rules, 2000, 4), t("s_entry_rules_h")),
      S.field(t("s_cancellation"), textarea("cancellation_policy", party.cancellation_policy, 2000, 4), t("s_cancellation_h")),
      S.field(t("s_payment"), textarea("payment_instructions", party.payment_instructions, 1000, 3), t("s_payment_h")),
    ], function (f) {
      return { rules: textOrNull(f, "rules"), cancellation_policy: textOrNull(f, "cancellation_policy"), payment_instructions: textOrNull(f, "payment_instructions") };
    });
  }

  // ------------------------------------------------------------- pictures

  function pictures() {
    var box = noteFor("pictures");
    var list = flyers.flyers || [];
    var grid = el("ul", { class: "s-pics" }, list.map(function (f, i) {
      var del = el("button", { class: "btn no small-btn", text: t("s_remove"), attrs: { type: "button" } });
      del.addEventListener("click", async function () {
        if (!window.confirm(t("s_remove_pic_confirm"))) return;
        del.disabled = true;
        var r = await S.act("/api/party/flyers/" + encodeURIComponent(f.id) + "/delete", { op: crypto.randomUUID() });
        if (!r.ok) { del.disabled = false; S.say(box, "no", S.why(r)); return; }
        await reloadPictures(["yes", t("s_pic_removed")]);
      });
      return el("li", null, el("img", { attrs: { src: f.url, alt: t("s_pic_alt", { n: i + 1 }), loading: "lazy" } }),
        el("div", { class: "s-pic-foot" }, el("span", { class: "small muted", text: i === 0 ? t("s_pic_first") : t("s_pic_n", { n: i + 1 }) }), del));
    }));
    var file = el("input", { class: "sr-file", attrs: { type: "file", accept: "image/jpeg,image/png,image/webp", id: "pic-file" } });
    var room = list.length < (flyers.max || 8);
    var pick = el("label", { class: "btn small-btn", text: t("s_add_pic"), attrs: { for: "pic-file" } });
    file.addEventListener("change", async function () {
      var chosen = file.files && file.files[0];
      if (!chosen) return;
      if (flyers.max_bytes && chosen.size > flyers.max_bytes) { S.say(box, "no", t("e_too_large")); return; }
      S.say(box, "maybe", t("s_uploading"));
      var op = crypto.randomUUID(), r;
      for (var i = 0; i < 5; i++) {
        var fd = new FormData();
        fd.append("op", op);
        fd.append("file", chosen);
        r = await Sahra.api.post("/api/party/flyers", fd);
        if (r.status !== 503 || !(r.body && r.body.retry)) break;
        await S.sleep(1500);
      }
      if (!r.ok) { S.say(box, "no", S.why(r)); return; }
      await reloadPictures(["yes", t("s_pic_added")]);
    });
    return S.section("pictures", t("s_pictures"), t("s_pictures_p", { max: flyers.max || 8 }),
      list.length ? grid : el("p", { class: "s-empty muted", text: t("s_no_pics") }),
      el("div", { class: "s-save" }, room ? [file, pick] : el("p", { class: "muted small", text: t("s_pics_full", { max: flyers.max || 8 }) }), box));
  }
  async function reloadPictures(note) {
    var r = await Sahra.api.get("/api/party/flyers");
    if (r.ok) flyers = r.body;
    rebuild("pictures", note);
  }

  // ------------------------------------------------------------- ticket types

  function peopleLine(x) {
    var min = x.min_people || 1, max = x.max_people || party.max_people_per_ticket;
    if (min === max) return min === 1 ? t("s_type_one") : t("s_type_exactly", { n: min });
    return t("people_range", { min: min, max: max });
  }

  function typeRow(x) {
    var tz = party.time_zone;
    var bits = [Sahra.money(x.price) + (x.price ? " " + t("s_pp") : ""), peopleLine(x),
      x.quantity !== null ? t("s_type_places", { held: x.held, of: x.quantity }) : t("s_type_held", { held: x.held })];
    var tags = [];
    if (x.staff_only) tags.push(["", t("s_staff_only")]);
    if (x.archived) tags.push(["no", t("s_archived")]);
    if (x.quantity !== null && x.places_left === 0) tags.push(["maybe", t("sold_out")]);
    if (x.sales_closes_at) tags.push(["", t("s_until", { when: Sahra.when(x.sales_closes_at, tz) })]);
    if (x.entry_from) tags.push(["", t("s_entry_from", { when: Sahra.time(x.entry_from, tz) })]);
    var edit = el("button", { class: "btn small-btn", text: t("s_edit"), attrs: { type: "button" } });
    edit.addEventListener("click", function () { editing = x.id; preset = null; rebuild("types"); focusEditor(); });
    return el("li", { class: x.archived ? "off" : null },
      el("div", { class: "s-type-text" }, el("strong", { text: x.name, attrs: { dir: "auto" } }),
        el("span", { class: "muted small", text: bits.join(" · ") }),
        tags.length ? el("span", { class: "s-tags" }, tags.map(function (g) { return el("span", { class: "pill " + g[0], text: g[1] }); })) : null),
      edit);
  }

  function focusEditor() {
    var f = document.getElementById("type-editor");
    if (f) { f.scrollIntoView({ block: "start" }); var n = f.querySelector("input[name=name]"); if (n) n.focus({ preventScroll: true }); }
  }

  var PRESETS = [
    ["s_preset_normal", { name: "Normal", min_people: 1, max_people: 1 }],
    ["s_preset_group", { name: "Group", min_people: 2, max_people: 6, description: "One QR code for the whole group. Arrive together." }],
    ["s_preset_early", { name: "Early", description: "Early-bird ticket." }],
    ["s_preset_staff", { name: "Guest list", price: 0, staff_only: true }],
  ];

  function typeEditor() {
    var x = editing === "new" ? Object.assign({ name: "", price: 0, quantity: null, sort: (types || []).length, min_people: null, max_people: null,
      sales_opens_at: null, sales_closes_at: null, entry_from: null, staff_only: false, archived: false, description: null, payment_instructions: null }, preset || {})
      : types.filter(function (y) { return y.id === editing; })[0];
    if (!x) return null;
    var tz = party.time_zone;
    var box = S.sayBox();
    var row = saveRow(editing === "new" ? t("s_add_type") : t("s_save"), box);
    var cancel = el("button", { class: "btn link", text: t("q_cancel"), attrs: { type: "button" } });
    cancel.addEventListener("click", function () { editing = null; rebuild("types"); });
    row.node.insertBefore(cancel, box);
    var f = el("form", { class: "s-editor", attrs: { id: "type-editor", novalidate: true } },
      el("h3", { text: editing === "new" ? t("s_new_type") : t("s_edit_type", { name: x.name }) }),
      el("div", { class: "s-two" },
        S.field(t("s_type_name"), S.input("name", "text", { maxlength: 60, required: true, value: x.name, dir: "auto" })),
        S.field(t("s_type_price"), S.input("price", "number", { min: 0, max: 1000000, value: x.price, inputmode: "numeric" }), t("s_type_price_h"))),
      el("div", { class: "s-two" },
        S.field(t("s_type_min"), S.input("min_people", "number", { min: 1, max: 50, value: x.min_people == null ? "" : x.min_people, placeholder: "1" })),
        S.field(t("s_type_max"), S.input("max_people", "number", { min: 1, max: 50, value: x.max_people == null ? "" : x.max_people, placeholder: String(party.max_people_per_ticket) }), t("s_type_max_h"))),
      el("div", { class: "s-two" },
        S.field(t("s_type_quantity"), S.input("quantity", "number", { min: 1, max: 100000, value: x.quantity == null ? "" : x.quantity, placeholder: t("s_no_limit") }), t("s_type_quantity_h")),
        S.field(t("s_type_sort"), S.input("sort", "number", { min: 0, max: 1000, value: x.sort || 0 }), t("s_type_sort_h"))),
      el("div", { class: "s-two" },
        S.field(t("s_sale_from"), S.input("sales_opens_at_local", "datetime-local", { value: S.local(x.sales_opens_at, tz) })),
        S.field(t("s_sale_until"), S.input("sales_closes_at_local", "datetime-local", { value: S.local(x.sales_closes_at, tz) }), t("s_sale_h"))),
      S.field(t("s_entry"), S.input("entry_from_local", "datetime-local", { value: S.local(x.entry_from, tz) }), t("s_entry_h")),
      S.field(t("s_type_desc"), textarea("description", x.description, 500, 2)),
      S.field(t("s_type_payment"), textarea("payment_instructions", x.payment_instructions, 1000, 2), t("s_type_payment_h")),
      el("div", { class: "s-checks" },
        S.check("staff_only", t("s_staff_only"), x.staff_only, t("s_staff_only_h")),
        editing !== "new" ? S.check("archived", t("s_archive"), x.archived, t("s_archive_h")) : null),
      row.node);
    f.addEventListener("submit", async function (e) {
      e.preventDefault();
      if (!val(f, "name")) { S.say(box, "no", t("s_name_needed")); return; }
      var body = { name: val(f, "name"), price: Number(f.elements.price.value || 0), sort: Number(f.elements.sort.value || 0),
        quantity: num(f, "quantity"), min_people: num(f, "min_people"), max_people: num(f, "max_people"),
        staff_only: f.elements.staff_only.checked, description: textOrNull(f, "description"), payment_instructions: textOrNull(f, "payment_instructions"),
        sales_opens_at_local: localOrNull(f, "sales_opens_at_local"), sales_closes_at_local: localOrNull(f, "sales_closes_at_local"), entry_from_local: localOrNull(f, "entry_from_local") };
      var path = "/api/tickets/types";
      if (editing === "new") body.op = f.dataset.op || (f.dataset.op = crypto.randomUUID());
      else { path += "/" + encodeURIComponent(editing); body.archived = f.elements.archived.checked; }
      row.button.disabled = true;
      S.say(box, "maybe", t("s_saving"));
      var r = await S.act(path, body);
      row.button.disabled = false;
      if (!r.ok) { S.say(box, "no", S.why(r)); return; }
      var g = await Sahra.api.get("/api/tickets/types");
      if (g.ok) types = g.body.types;
      editing = null;
      rebuild("types", ["yes", t("s_saved")]);
    });
    return f;
  }

  function typesCard() {
    var box = noteFor("types");
    var list = types || [];
    var add = el("div", { class: "s-presets" }, el("span", { class: "small muted", text: t("s_add_from") }),
      PRESETS.map(function (p) {
        return el("button", { class: "chip", text: t(p[0]), attrs: { type: "button" }, on: { click: function () {
          editing = "new"; preset = p[1]; rebuild("types"); focusEditor();
        } } });
      }),
      el("button", { class: "chip", text: t("s_preset_blank"), attrs: { type: "button" }, on: { click: function () {
        editing = "new"; preset = null; rebuild("types"); focusEditor();
      } } }));
    return S.section("types", t("s_types"), t("s_types_p"),
      list.length ? el("ul", { class: "s-list" }, list.map(typeRow)) : el("p", { class: "s-empty muted", text: t("s_no_types") }),
      box, editing ? typeEditor() : add);
  }

  // ------------------------------------------------------------- guest form

  function qId(label, taken) {
    var base = String(label).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 24) || "q";
    var id = base, n = 2;
    while (taken[id]) id = (base + "_" + n++).slice(0, 32);
    return id;
  }

  function questionRow(q, i) {
    var label = S.input("q_label", "text", { maxlength: 200, value: q.label, dir: "auto" });
    label.addEventListener("input", function () { q.label = label.value; });
    var type = S.select("q_type", [["text", t("s_q_text")], ["choice", t("s_q_choice")]], q.type);
    var opts = textarea("q_options", (q.options || []).join("\n"), 2100, 3);
    var optsField = S.field(t("s_q_options"), opts, t("s_q_options_h"));
    optsField.hidden = q.type !== "choice";
    opts.addEventListener("input", function () { q.options = opts.value.split("\n").map(function (s) { return s.trim(); }).filter(Boolean); });
    type.addEventListener("change", function () { q.type = type.value; optsField.hidden = q.type !== "choice"; });
    var req = S.check("q_required", t("s_q_required"), q.required);
    req.querySelector("input").addEventListener("change", function (e) { q.required = e.target.checked; });
    var move = function (d) { return function () { var j = i + d; if (j < 0 || j >= questions.length) return; questions.splice(j, 0, questions.splice(i, 1)[0]); rebuild("form"); }; };
    return el("li", { class: "s-question" },
      el("div", { class: "s-q-top" }, el("span", { class: "small muted", text: t("s_q_n", { n: i + 1 }) }),
        el("span", { class: "s-q-tools" },
          el("button", { class: "btn link", text: t("s_up"), attrs: { type: "button", disabled: i === 0 }, on: { click: move(-1) } }),
          el("button", { class: "btn link", text: t("s_down"), attrs: { type: "button", disabled: i === questions.length - 1 }, on: { click: move(1) } }),
          el("button", { class: "btn link danger", text: t("s_remove"), attrs: { type: "button" }, on: { click: function () { questions.splice(i, 1); rebuild("form"); } } }))),
      el("div", { class: "s-two" }, S.field(t("s_q_label"), label), S.field(t("s_q_type"), type)),
      optsField, req);
  }

  function formCardGuest() {
    if (!form) return S.section("form", t("s_form"), null, el("p", { class: "notice no", text: t("error_generic") }));
    if (!questions) questions = form.questions.map(function (q) { return Object.assign({}, q, { options: (q.options || []).slice() }); });
    var box = noteFor("form");
    var asks = el("div", { class: "s-asks" }, [["screenshot", "s_ask_screenshot", "s_ask_screenshot_h"], ["id_photo", "s_ask_id", "s_ask_id_h"], ["instagram", "s_ask_ig", "s_ask_ig_h"]]
      .map(function (a) {
        return S.field(t(a[1]), S.select(a[0], ASKS.map(function (x) { return [x[0], t(x[1])]; }), form[a[0]] || (a[0] === "screenshot" ? "required" : "none")), t(a[2]));
      }));
    var add = el("button", { class: "btn small-btn", text: t("s_q_add"), attrs: { type: "button", disabled: questions.length >= 20 } });
    add.addEventListener("click", function () { questions.push({ id: "", label: "", type: "text", required: false, options: [] }); rebuild("form"); });
    var row = saveRow(t("s_save_form"), box);
    var f = el("form", { attrs: { novalidate: true } },
      el("p", { class: "small muted", text: t("s_form_always") }), asks,
      el("h3", { class: "s-sub", text: t("s_questions") }),
      questions.length ? el("ol", { class: "s-questions" }, questions.map(questionRow)) : el("p", { class: "s-empty muted", text: t("s_no_questions") }),
      add, row.node);
    f.addEventListener("submit", async function (e) {
      e.preventDefault();
      var taken = {};
      questions.forEach(function (q) { if (q.id) taken[q.id] = true; });
      for (var i = 0; i < questions.length; i++) {
        var q = questions[i];
        if (!q.label.trim()) { S.say(box, "no", t("s_q_label_needed", { n: i + 1 })); return; }
        if (q.type === "choice" && !q.options.length) { S.say(box, "no", t("s_q_options_needed", { n: i + 1 })); return; }
        if (!q.id) { q.id = qId(q.label, taken); taken[q.id] = true; }
      }
      var body = { questions: questions.map(function (q) {
        var o = { id: q.id, label: q.label.trim(), type: q.type, required: !!q.required };
        if (q.type === "choice") o.options = q.options;
        return o;
      }), screenshot: f.elements.screenshot.value, id_photo: f.elements.id_photo.value, instagram: f.elements.instagram.value };
      row.button.disabled = true;
      S.say(box, "maybe", t("s_saving"));
      var r = await S.act("/api/tickets/form", { form: body });
      row.button.disabled = false;
      if (!r.ok) { S.say(box, "no", S.why(r)); return; }
      form = r.body.form;
      questions = null;
      rebuild("form", ["yes", t("s_saved")]);
    });
    return S.section("form", t("s_form"), t("s_form_p"), f);
  }

  // ------------------------------------------------------------- emails

  function emails() {
    var em = party.emails || {};
    return formCard("emails", t("s_emails"), t("s_emails_p"), [
      el("h3", { class: "s-sub", text: t("s_email_ticket") }),
      el("p", { class: "small muted" }, t("s_placeholders"), " ", el("code", { text: "{guest_name} {party_name} {link} {people_note}", attrs: { dir: "ltr" } }), " ", t("s_link_required", { name: "{link}" })),
      S.field(t("s_subject"), S.input("email_ticket_subject", "text", { maxlength: 150, value: em.ticket_subject || "", placeholder: t("s_default_text"), dir: "auto" })),
      S.field(t("s_body"), textarea("email_ticket_body", em.ticket_body, 2000, 7)),
      el("h3", { class: "s-sub", text: t("s_email_link") }),
      el("p", { class: "small muted" }, t("s_placeholders"), " ", el("code", { text: "{party_name} {links}", attrs: { dir: "ltr" } }), " ", t("s_link_required", { name: "{links}" })),
      S.field(t("s_subject"), S.input("email_link_subject", "text", { maxlength: 150, value: em.link_subject || "", placeholder: t("s_default_text"), dir: "auto" })),
      S.field(t("s_body"), textarea("email_link_body", em.link_body, 2000, 5)),
    ], function (f) {
      return { email_ticket_subject: textOrNull(f, "email_ticket_subject"), email_ticket_body: textOrNull(f, "email_ticket_body"),
        email_link_subject: textOrNull(f, "email_link_subject"), email_link_body: textOrNull(f, "email_link_body") };
    });
  }

  // Cancel the party (owners; brainstorm idea 14). Cannot be undone: admission pauses, requests stop,
  // paid tickets can be marked "refund due", and a notice to every guest waits in Emails for approval.
  var cancelOp = null, who = null;
  function cancelCard() {
    if (!who || who.staff.role !== "owner") return el("div");
    if (party.cancelled_at) {
      return S.section("cancel", t("s_cancelled"), t("s_cancelled_p", { when: Sahra.when(party.cancelled_at, party.time_zone) }),
        noteFor("cancel"),
        party.cancel_reason ? el("p", { class: "pre", text: party.cancel_reason, attrs: { dir: "auto" } }) : null,
        el("div", { class: "g-actions" }, el("a", { class: "btn small-btn", text: t("s_open_refunds"), attrs: { href: "/guests.html#refunds" } }),
          el("a", { class: "btn small-btn", text: t("s_open_emails"), attrs: { href: "/outbox.html" } })));
    }
    var box = noteFor("cancel");
    var go = el("button", { class: "btn no small-btn", text: t("s_cancel_go"), attrs: { type: "submit" } });
    var f = el("form", { attrs: { novalidate: true } },
      S.field(t("s_cancel_reason"), textarea("reason", "", 500, 3), t("s_cancel_reason_h")),
      S.check("mark_refunds", t("s_cancel_refunds"), true, t("s_cancel_refunds_h")),
      S.check("email_guests", t("s_cancel_email"), true, t("s_cancel_email_h")),
      el("div", { class: "s-save" }, go, box));
    f.addEventListener("submit", async function (e) {
      e.preventDefault();
      var typed = window.prompt(t("s_cancel_confirm", { name: party.name }));
      if (typed === null) return;
      if (typed.trim() !== party.name.trim()) { S.say(box, "no", t("s_cancel_mismatch")); return; }
      cancelOp = cancelOp || crypto.randomUUID();
      go.disabled = true;
      S.say(box, "maybe", t("s_saving"));
      var r = await S.act("/api/party/cancel", { op: cancelOp, reason: f.elements.reason.value.trim() || null,
        mark_refunds: f.elements.mark_refunds.checked, email_guests: f.elements.email_guests.checked });
      go.disabled = false;
      if (!r.ok) { S.say(box, "no", S.why(r)); return; }
      var g = await Sahra.api.get("/api/party");
      if (g.ok) party = g.body;
      rebuild("cancel", ["yes", t("s_cancel_done", { due: r.body.refunds_due, emails: r.body.emails_queued })]);
    });
    var card = S.section("cancel", t("s_cancel"), t("s_cancel_p"), f);
    card.classList.add("s-danger");
    return card;
  }

  var BUILD = { basics: basics, contact: contact, time: time, location: location, requests: requests, rules: rules, pictures: pictures, types: typesCard, form: formCardGuest, emails: emails, cancel: cancelCard };
  var ORDER = [["basics", "s_basics"], ["contact", "s_contact"], ["time", "s_time"], ["location", "s_location"], ["requests", "s_requests"], ["rules", "s_rules"],
    ["pictures", "s_pictures"], ["types", "s_types"], ["form", "s_form"], ["emails", "s_emails"], ["cancel", "s_cancel"]];

  function render(me, app) {
    who = me;
    if (loadErr) { app.appendChild(el("p", { class: "notice no", text: S.why(loadErr) })); return; }
    if (!party) { app.appendChild(el("p", { class: "muted", text: t("loading") })); return; }
    var order = ORDER.filter(function (o) { return o[0] !== "cancel" || me.staff.role === "owner"; });
    var toc = el("nav", { class: "s-toc", attrs: { "aria-label": t("s_sections") } }, el("ul", null, order.map(function (o) {
      return el("li", null, el("a", { text: t(o[1]), attrs: { href: "#" + o[0] } }));
    })));
    var main = el("div", { class: "s-main" });
    order.forEach(function (o) { nodes[o[0]] = BUILD[o[0]](); main.appendChild(nodes[o[0]]); });
    app.appendChild(el("div", { class: "s-layout" }, toc, main));
  }

  var ready = false;
  SahraStaff.start({
    page: "settings", title: "s_settings_title", lede: "s_settings_lede",
    actions: function (me) {
      return [el("a", { class: "btn small-btn", text: t("s_view_page"), attrs: { href: "/signup.html?party=" + encodeURIComponent(me.party.id), target: "_blank", rel: "noopener" } })];
    },
    render: function (me, app) {
      render(me, app);
      if (!ready) { ready = true; load().then(function () { Sahra.clear(app); SahraStaff.redraw(); }); }
    },
  });
})();
