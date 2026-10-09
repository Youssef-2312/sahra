"use strict";
(async function () {
  var out = document.getElementById("out");
  function show(x) { out.textContent = JSON.stringify(x, null, 2); }
  var me = await Sahra.me();
  if (!me) { location.href = "/"; return; }
  document.getElementById("me").textContent = JSON.stringify(me, null, 2);

  document.getElementById("logout").addEventListener("click", async function () {
    await Sahra.post("/api/auth/logout");
    try { localStorage.removeItem("sahra_session"); } catch (e) {}
    location.href = "/";
  });

  async function loadStaff() {
    var r = await fetch("/api/staff", { credentials: "same-origin" });
    document.getElementById("staff").textContent = JSON.stringify(await r.json(), null, 2);
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

  if (me.staff.role === "owner") {
    document.getElementById("owner").hidden = false;
    loadStaff();
    document.getElementById("ginvite").addEventListener("submit", async function (e) {
      e.preventDefault();
      var f = new FormData(e.target);
      show(await act("/api/staff/google-invite", {
        staff_id: crypto.randomUUID(), invite_id: crypto.randomUUID(),
        name: f.get("name"), email: f.get("email"), role: f.get("role"),
      }));
      loadStaff();
    });
    document.getElementById("dinvite").addEventListener("submit", async function (e) {
      e.preventDefault();
      var f = new FormData(e.target);
      var existing = String(f.get("staff_id") || "").trim();
      var token = Sahra.token();
      var r = await act("/api/staff/door-invite", {
        staff_id: existing || crypto.randomUUID(), invite_id: crypto.randomUUID(),
        name: existing ? null : f.get("name"), token: token, hours: Number(f.get("hours")),
      });
      show(r);
      if (r.status === 200) document.getElementById("link").textContent = location.origin + "/join#t=" + token;
      loadStaff();
    });
    document.getElementById("change").addEventListener("submit", async function (e) {
      e.preventDefault();
      var f = new FormData(e.target);
      var id = String(f.get("id")).trim();
      var a = String(f.get("action"));
      if (a === "disable") show(await act("/api/staff/" + id + "/disable"));
      else if (a === "revoke") show(await act("/api/invites/" + id + "/revoke"));
      else show(await act("/api/staff/" + id + "/role", { role: a.split(":")[1] }));
      loadStaff();
    });
  }

  async function loadAdmission() {
    var r = await fetch("/api/admission", { credentials: "same-origin" });
    document.getElementById("admission").textContent = JSON.stringify(await r.json(), null, 2);
  }
  loadAdmission();
  if (me.staff.role !== "door") {
    document.getElementById("admission-buttons").hidden = false;
    document.getElementById("open").addEventListener("click", async function () { show(await act("/api/admission", { action: "open" })); loadAdmission(); });
    document.getElementById("pause").addEventListener("click", async function () { show(await act("/api/admission", { action: "pause" })); loadAdmission(); });
  }

  document.getElementById("mktickets").addEventListener("submit", async function (e) {
    e.preventDefault();
    var f = new FormData(e.target);
    var r = await Sahra.post("/api/test/tickets", { count: Number(f.get("count")), people: Number(f.get("people")) });
    document.getElementById("tickets").textContent = r.status === 200 ? r.body.tickets.map(function (t) { return t.qr; }).join("\n") : JSON.stringify(r);
  });

  // One scan id per physical scan; reused only when retrying that same scan
  // (network error or "recording"). Anything but "admit" is not an entry.
  document.getElementById("scan").addEventListener("submit", async function (e) {
    e.preventDefault();
    var qr = String(new FormData(e.target).get("qr"));
    var scanId = crypto.randomUUID();
    var out = document.getElementById("verdict");
    var v = null;
    for (var i = 0; i < 6; i++) {
      try {
        var r = await Sahra.post("/api/scan", { scan_id: scanId, qr: qr });
        v = r.status === 200 ? r.body : { verdict: "cant_verify", http: r.status };
      } catch (err) {
        v = { verdict: "cant_verify", network: true };
      }
      if (v.verdict !== "recording" && !v.network) break;
      out.textContent = "Recording entry... (retry " + (i + 1) + ")";
      await new Promise(function (ok) { setTimeout(ok, 800); });
    }
    out.textContent = (v.verdict === "admit" ? "GREEN: ADMIT\n" : "NOT GREEN: DO NOT ADMIT\n") + JSON.stringify(v, null, 2);
  });
})();
