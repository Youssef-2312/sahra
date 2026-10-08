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
    ["name", "description", "time_zone", "venue_name", "address", "map_url", "rules", "payment_instructions",
      "capacity", "max_people_per_ticket", "address_mode"].forEach(function (k) {
      form.elements[k].value = party[k] === null || party[k] === undefined ? "" : party[k];
    });
    var tz = party.time_zone;
    form.elements.starts_at_local.value = local(party.starts_at, tz);
    form.elements.ends_at_local.value = local(party.ends_at, tz);
    form.elements.reveal_at_local.value = local(party.reveal_at, tz);
    form.elements.address_locked_at_local.value = local(party.address_locked_at, tz);
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
    ["name", "description", "time_zone", "venue_name", "address", "map_url", "rules", "payment_instructions", "address_mode"]
      .forEach(function (k) { body[k] = String(f.get(k) || "").trim() || null; });
    ["capacity", "max_people_per_ticket"].forEach(function (k) { if (f.get(k) !== "") body[k] = Number(f.get(k)); });
    ["starts_at_local", "ends_at_local", "reveal_at_local", "address_locked_at_local"]
      .forEach(function (k) { body[k] = f.get(k) ? String(f.get(k)).slice(0, 16) : null; });
    // Unchanged lock: do not resend it (once passed, the server refuses any change to it).
    if (party && body.address_locked_at_local === local(party.address_locked_at, party.time_zone)) delete body.address_locked_at_local;
    if (f.get("notify_guests")) body.notify_guests = true;
    show(await act("/api/party/details", body));
    load();
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
