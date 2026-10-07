"use strict";
(async function () {
  var out = document.getElementById("out");
  function show(x) { out.textContent = JSON.stringify(x, null, 2); }
  var me = await Sahra.me();
  if (!me) { location.href = "/"; return; }
  document.getElementById("me").textContent = JSON.stringify(me, null, 2);
  document.getElementById("proto").hidden = false;

  document.getElementById("logout").addEventListener("click", async function () {
    await Sahra.post("/api/auth/logout");
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

  document.getElementById("mkticket").addEventListener("click", async function () {
    var r = await Sahra.post("/api/proto/ticket");
    show(r);
    if (r.body.qr) document.querySelector("#scan input[name=qr]").value = r.body.qr;
  });
  document.getElementById("scan").addEventListener("submit", async function (e) {
    e.preventDefault();
    var qr = new FormData(e.target).get("qr");
    // One scan id per physical scan; reused only when retrying that same scan.
    var scanId = crypto.randomUUID();
    for (var i = 0; i < 5; i++) {
      var r;
      try { r = await Sahra.post("/api/proto/scan", { scan_id: scanId, qr: qr }); } catch (err) { continue; }
      if (r.body.verdict !== "recording") break;
    }
    show(r || { verdict: "cant_verify" });
  });
})();
