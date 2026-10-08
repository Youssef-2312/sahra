// Guest ticket page (bare test page). The signed link is in the URL fragment
// (#t=...), which the browser never sends to a server; it goes to the API in a header.
"use strict";
(function () {
  var t = new URLSearchParams(location.hash.slice(1)).get("t") || "";
  async function load() {
    var r = await fetch("/api/guest/ticket", { headers: { "x-sahra-ticket": t } });
    var j = await r.json().catch(function () { return {}; });
    var out = document.getElementById("ticket");
    if (!r.ok) { out.textContent = "This link is not valid (it may have been replaced)."; return; }
    var k = j.ticket;
    var lines = ["Party: " + j.party.name, "Name: " + (k.guest_name || ""), "People: " + k.people, "Status: " + k.status];
    if (k.type) lines.push("Ticket type: " + k.type);
    if (k.group_note) lines.push(k.group_note);
    if (k.reject_reason) lines.push("Reason: " + k.reject_reason);
    if (k.on_hold) lines.push("On hold: the organisers are checking this ticket.");
    if (k.used) lines.push("Already used at the door.");
    out.textContent = lines.join("\n");
    document.getElementById("qr-box").hidden = !k.qr;
    // The frontend stage renders this text as a QR code (large, white background, quiet zone).
    document.getElementById("qr").textContent = k.qr || "";
  }
  document.getElementById("refresh").addEventListener("click", load);
  load();
})();
