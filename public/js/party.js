"use strict";
(async function () {
  var out = document.getElementById("out");
  function show(x) { out.textContent = JSON.stringify(x, null, 2); }
  var me = await Sahra.me();
  if (!me) { location.href = "/"; return; }
  var form = document.getElementById("edit");
  var party = null;

  // Instant (UTC ms) to the value of a datetime-local input in the party's zone.
  function local(ms, tz) {
    if (ms === null || ms === undefined || !tz) return "";
    var p = {};
    new Intl.DateTimeFormat("en-GB", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      .formatToParts(ms).forEach(function (x) { p[x.type] = x.value; });
    return p.year + "-" + p.month + "-" + p.day + "T" + p.hour + ":" + p.minute;
  }

  async function load() {
    var r = await fetch("/api/party", { credentials: "same-origin" });
    party = await r.json();
    document.getElementById("current").textContent = JSON.stringify(party, null, 2);
    if (me.staff.role === "door") return;
    document.getElementById("editor").hidden = false;
    ["name", "description", "time_zone", "venue_name", "address", "map_url", "rules", "cancellation_policy", "payment_instructions",
      "capacity", "max_people_per_ticket", "address_mode"].forEach(function (k) {
      form.elements[k].value = party[k] === null || party[k] === undefined ? "" : party[k];
    });
    var tz = party.time_zone;
    form.elements.starts_at_local.value = local(party.starts_at, tz);
    form.elements.ends_at_local.value = local(party.ends_at, tz);
    form.elements.reveal_at_local.value = local(party.reveal_at, tz);
    form.elements.address_locked_at_local.value = local(party.address_locked_at, tz);
    form.elements.registration_opens_at_local.value = local(party.registration_opens_at, tz);
    form.elements.registration_closes_at_local.value = local(party.registration_closes_at, tz);
    form.elements.max_tickets_per_email.value = party.max_tickets_per_email === null ? "" : party.max_tickets_per_email;
    loadTypes();
    var em = party.emails || {};
    var ef = document.getElementById("emails").elements;
    ef.email_ticket_subject.value = em.ticket_subject || "";
    ef.email_ticket_body.value = em.ticket_body || "";
    ef.email_link_subject.value = em.link_subject || "";
    ef.email_link_body.value = em.link_body || "";
  }

  // Retries an action that came back "pending" (change not yet recorded) with the same body.
  async function act(path, body) {
    for (var i = 0; i < 5; i++) {
      var r = await Sahra.post(path, body);
      if (r.status !== 503) return r;
      await new Promise(function (ok) { setTimeout(ok, 1500); });
    }
    return r;
  }

  document.getElementById("emails").addEventListener("submit", async function (e) {
    e.preventDefault();
    var f = new FormData(e.target);
    var body = {};
    ["email_ticket_subject", "email_ticket_body", "email_link_subject", "email_link_body"]
      .forEach(function (k) { body[k] = String(f.get(k) || "").trim() || null; });
    show(await act("/api/party/details", body));
    load();
  });

  form.addEventListener("submit", async function (e) {
    e.preventDefault();
    var f = new FormData(form);
    var body = {};
    ["name", "description", "time_zone", "venue_name", "address", "map_url", "rules", "cancellation_policy", "payment_instructions", "address_mode"]
      .forEach(function (k) { body[k] = String(f.get(k) || "").trim() || null; });
    ["capacity", "max_people_per_ticket"].forEach(function (k) { if (f.get(k) !== "") body[k] = Number(f.get(k)); });
    body.max_tickets_per_email = f.get("max_tickets_per_email") === "" ? null : Number(f.get("max_tickets_per_email"));
    ["starts_at_local", "ends_at_local", "reveal_at_local", "address_locked_at_local", "registration_opens_at_local", "registration_closes_at_local"]
      .forEach(function (k) { body[k] = f.get(k) ? String(f.get(k)).slice(0, 16) : null; });
    // Unchanged lock: do not resend it (once passed, the server refuses any change to it).
    if (party && body.address_locked_at_local === local(party.address_locked_at, party.time_zone)) delete body.address_locked_at_local;
    if (f.get("notify_guests")) body.notify_guests = true;
    show(await act("/api/party/details", body));
    load();
  });

  // ---------------------------------------------------------- ticket types
  var types = [];
  var tf = document.getElementById("type");
  async function loadTypes() {
    var r = await fetch("/api/tickets/types", { credentials: "same-origin" });
    var j = await r.json();
    types = j.types || [];
    document.getElementById("types").textContent = types.length ? types.map(function (t) {
      return t.name + ": EGP " + t.price + (t.quantity !== null ? ", " + t.held + " of " + t.quantity + " places held" : ", " + t.held + " held") +
        (t.staff_only ? ", staff only" : "") + (t.archived ? ", archived" : "") + (t.entry_from ? ", entry from " + local(t.entry_from, party.time_zone) : "") +
        (t.sales_closes_at ? ", on sale until " + local(t.sales_closes_at, party.time_zone) : "");
    }).join("\n") : "No ticket types: guests request a plain ticket.";
    var sel = document.querySelector("#type-pick [name=id]");
    sel.textContent = "";
    types.forEach(function (t) { var o = document.createElement("option"); o.value = t.id; o.textContent = t.name; sel.appendChild(o); });
  }
  function fillType(t) {
    tf.reset();
    tf.elements.id.value = t ? t.id : "";
    if (!t) return;
    ["name", "price", "sort", "description", "payment_instructions"].forEach(function (k) { tf.elements[k].value = t[k] === null ? "" : t[k]; });
    tf.elements.quantity.value = t.quantity === null ? "" : t.quantity;
    ["sales_opens_at", "sales_closes_at", "entry_from"].forEach(function (k) { tf.elements[k + "_local"].value = local(t[k], party.time_zone); });
    tf.elements.staff_only.checked = !!t.staff_only;
    tf.elements.archived.checked = !!t.archived;
  }
  document.getElementById("type-new").addEventListener("click", function () { fillType(null); });
  document.getElementById("type-early").addEventListener("click", function () {
    fillType(null);
    tf.elements.name.value = "Early";
    tf.elements.description.value = "Early-bird ticket.";
  });
  document.getElementById("type-pick").addEventListener("submit", function (e) {
    e.preventDefault();
    var id = new FormData(e.target).get("id");
    fillType(types.filter(function (t) { return t.id === id; })[0] || null);
  });
  tf.addEventListener("submit", async function (e) {
    e.preventDefault();
    var f = new FormData(tf);
    var body = { name: String(f.get("name")).trim(), price: Number(f.get("price")), sort: Number(f.get("sort") || 0),
      quantity: f.get("quantity") === "" ? null : Number(f.get("quantity")), staff_only: !!f.get("staff_only"),
      description: String(f.get("description") || "").trim() || null, payment_instructions: String(f.get("payment_instructions") || "").trim() || null };
    ["sales_opens_at_local", "sales_closes_at_local", "entry_from_local"].forEach(function (k) { body[k] = f.get(k) ? String(f.get(k)).slice(0, 16) : null; });
    var id = f.get("id");
    if (id) {
      body.archived = !!f.get("archived");
      show(await act("/api/tickets/types/" + id, body));
    } else {
      body.op = crypto.randomUUID();
      show(await act("/api/tickets/types", body));
      fillType(null);
    }
    loadTypes();
  });

  document.getElementById("reveal").addEventListener("click", async function () {
    show(await act("/api/party/reveal", {}));
    load();
  });

  document.getElementById("preview").addEventListener("submit", async function (e) {
    e.preventDefault();
    var f = new FormData(e.target);
    var url = f.get("viewer") === "public" ? "/api/party/public/" + encodeURIComponent(party.id)
      : "/api/party/preview?viewer=ticket&status=" + encodeURIComponent(f.get("status")) +
        "&released=" + (f.get("released") ? "1" : "0") + "&on_hold=" + (f.get("on_hold") ? "1" : "0");
    var r = await fetch(url, { credentials: "same-origin" });
    document.getElementById("view").textContent = JSON.stringify(await r.json(), null, 2);
  });

  load();
})();
