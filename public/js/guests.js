// Live numbers, find a guest + resend, staff-issued tickets, announcements (bare test page).
"use strict";
(async function () {
  var out = document.getElementById("out");
  function show(v) { out.textContent = typeof v === "string" ? v : JSON.stringify(v, null, 2); }
  async function get(path) {
    var r = await fetch(path, { credentials: "same-origin" });
    return { status: r.status, body: await r.json().catch(function () { return {}; }) };
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
  function cell(tr, text) { var td = document.createElement("td"); td.textContent = text; tr.appendChild(td); return td; }
  function hhmm(ms) { return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }

  var me = await Sahra.me();
  if (!me) { location.href = "/"; return; }

  async function stats() {
    var r = await get("/api/party/stats");
    if (r.status !== 200) { document.getElementById("stats").textContent = JSON.stringify(r); return; }
    var s = r.body;
    var lines = ["Inside: " + s.inside + " people (" + s.admitted_tickets + " tickets)",
      "Places held: " + s.held + " of " + s.capacity + " (" + s.places_left + " left); pending " + s.pending + ", approved " + s.approved + ", QR sent " + s.released];
    s.by_type.forEach(function (t) {
      lines.push("  " + t.name + ": held " + (t.pending + t.approved) + (t.quantity !== null ? " of " + t.quantity : "") + ", inside " + t.admitted);
    });
    if (s.check_ins_per_10_min.length) {
      lines.push("Check-ins per 10 minutes:");
      s.check_ins_per_10_min.forEach(function (x) { lines.push("  " + hhmm(x.at) + "  " + x.people + " people"); });
    }
    if (s.by_scanner.length) {
      lines.push("Per scanner:");
      s.by_scanner.forEach(function (x) { lines.push("  " + (x.name || "?") + ": " + x.people + " people"); });
    }
    document.getElementById("stats").textContent = lines.join("\n");
  }
  document.getElementById("stats-reload").addEventListener("click", stats);
  stats();
  // Once a minute at most: each refresh reads the party's tickets twice.
  setInterval(stats, 60_000);

  if (me.staff.role === "door") return;
  document.getElementById("managers").hidden = false;

  var t = await get("/api/tickets/types");
  (t.body.types || []).filter(function (x) { return !x.archived; }).forEach(function (x) {
    ["#issue", "#announce"].forEach(function (f) {
      var o = document.createElement("option");
      o.value = x.id;
      o.textContent = x.name + (x.staff_only ? " (staff only)" : "");
      document.querySelector(f + " [name=type_id]").appendChild(o);
    });
  });

  document.getElementById("search").addEventListener("submit", async function (e) {
    e.preventDefault();
    var q = String(new FormData(e.target).get("q")).trim();
    var r = await get("/api/tickets/search?q=" + encodeURIComponent(q));
    if (r.status !== 200) return show(r);
    var tbody = document.querySelector("#found tbody");
    tbody.textContent = "";
    r.body.tickets.forEach(function (x) {
      var tr = document.createElement("tr");
      cell(tr, x.guest_name || "");
      cell(tr, x.guest_email || "");
      cell(tr, x.type_name || "");
      cell(tr, String(x.people));
      cell(tr, x.status + (x.released_at ? " (QR sent)" : "") + (x.used_at ? " (inside)" : "") + (x.hold_at ? " (on hold)" : ""));
      var b = document.createElement("button");
      b.type = "button";
      b.textContent = "Resend ticket";
      b.addEventListener("click", async function () {
        var res = await Sahra.post("/api/tickets/" + x.id + "/resend", {});
        show(res.status === 200 ? (res.body.status === "queued" ? "Email queued. " : "Already emailed in the last 10 minutes. ") +
          "Link (private): " + location.origin + res.body.link : res);
      });
      cell(tr, "").appendChild(b);
      tbody.appendChild(tr);
    });
    if (!r.body.tickets.length) show("No guest found.");
  });

  document.getElementById("issue").addEventListener("submit", async function (e) {
    e.preventDefault();
    var f = new FormData(e.target);
    var r = await act("/api/tickets/issue", {
      op: crypto.randomUUID(), name: String(f.get("name")).trim(), email: String(f.get("email") || "").trim() || null,
      people: Number(f.get("people") || 1), type_id: f.get("type_id") || null,
      complimentary: !!f.get("complimentary"), release: !!f.get("release"),
    });
    show(r.status === 201 || r.status === 200 ? "Ticket " + r.body.ticket_id + " issued. Link (private): " + location.origin + r.body.link : r);
    stats();
  });

  document.getElementById("announce").addEventListener("submit", async function (e) {
    e.preventDefault();
    var f = new FormData(e.target);
    var r = await act("/api/party/announce", {
      op: crypto.randomUUID(), subject: String(f.get("subject")).trim(), body: String(f.get("body")).trim(),
      audience: f.get("audience"), type_id: f.get("type_id") || null,
    });
    show(r.status === 200 ? r.body.queued + " email(s) waiting for approval in the outbox" +
      (r.body.not_queued ? " (" + r.body.not_queued + " over the limit, not queued)" : "") + "." : r);
  });
})();
