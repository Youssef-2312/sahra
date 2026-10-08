// Approval queue, release, cancel / reissue / transfer, form and export (bare test page).
"use strict";
(function () {
  var out = document.getElementById("out");
  var next = null;
  var pendingOp = {};
  function show(v) { out.textContent = typeof v === "string" ? v : JSON.stringify(v, null, 2); }
  async function get(path) {
    var r = await fetch(path, { credentials: "same-origin" });
    return { status: r.status, body: await r.json().catch(function () { return {}; }) };
  }
  function cell(tr, text) { var td = document.createElement("td"); td.textContent = text; tr.appendChild(td); return td; }

  async function load(append) {
    var status = document.getElementById("status").value;
    var r = await get("/api/tickets?status=" + status + (append && next ? "&after=" + next : ""));
    if (r.status !== 200) return show(r);
    var tbody = document.querySelector("#list tbody");
    if (!append) tbody.textContent = "";
    r.body.tickets.forEach(function (t) {
      var tr = document.createElement("tr");
      var box = document.createElement("input");
      box.type = "checkbox";
      box.value = t.id;
      cell(tr, "").appendChild(box);
      cell(tr, t.guest_name || "");
      cell(tr, t.guest_email || "");
      cell(tr, String(t.people));
      cell(tr, JSON.stringify(t.answers));
      cell(tr, t.status + (t.released_at ? " (QR sent)" : "") + (t.reject_reason ? ": " + t.reject_reason : ""));
      var td = cell(tr, "");
      if (t.has_screenshot) {
        var b = document.createElement("button");
        b.type = "button";
        b.textContent = "View";
        b.addEventListener("click", function () { zoom(t.id); });
        td.appendChild(b);
      }
      tbody.appendChild(tr);
    });
    next = r.body.next;
    document.getElementById("more").hidden = !next;
  }

  // The image comes from an authenticated endpoint; shown as a data: URL (the page CSP allows data: images).
  async function zoom(id) {
    var r = await fetch("/api/tickets/" + id + "/screenshot", { credentials: "same-origin" });
    if (!r.ok) return show({ status: r.status });
    var blob = await r.blob();
    var reader = new FileReader();
    reader.onload = function () { var img = document.getElementById("zoom"); img.src = reader.result; img.hidden = false; };
    reader.readAsDataURL(blob);
  }

  function selected() {
    return Array.prototype.map.call(document.querySelectorAll("#list tbody input:checked"), function (b) { return b.value; });
  }
  async function bulk(path, extra) {
    var body = Object.assign({ ids: selected() }, extra || {});
    var r = await Sahra.post(path, body);
    show(r.status === 503 ? "Not confirmed yet: press again." : r);
    if (r.status === 200) load(false);
  }
  document.getElementById("approve").addEventListener("click", function () { bulk("/api/tickets/approve"); });
  document.getElementById("reject").addEventListener("click", function () { bulk("/api/tickets/reject", { reason: document.getElementById("reason").value }); });
  document.getElementById("release").addEventListener("click", function () { bulk("/api/tickets/release"); });
  document.getElementById("reload").addEventListener("click", function () { load(false); });
  document.getElementById("more").addEventListener("click", function () { load(true); });
  document.getElementById("status").addEventListener("change", function () { load(false); });

  document.getElementById("one").addEventListener("submit", async function (e) {
    e.preventDefault();
    var f = e.target;
    var key = f.action.value + ":" + f.id.value;
    // The same op id is reused until the change is confirmed, so a retry is recognized.
    pendingOp[key] = pendingOp[key] || crypto.randomUUID();
    var body = { op: pendingOp[key] };
    if (f.action.value === "transfer") { body.name = f.name.value; if (f.email.value) body.email = f.email.value; }
    var r = await Sahra.post("/api/tickets/" + encodeURIComponent(f.id.value) + "/" + f.action.value, body);
    if (r.status !== 503) delete pendingOp[key];
    if (r.body.link) r.body.link = location.origin + r.body.link;
    show(r.status === 503 ? "Not confirmed yet: press again." : r);
  });

  document.getElementById("save-form").addEventListener("click", async function () {
    var form;
    try { form = JSON.parse(document.getElementById("form").value); } catch (e) { return show("Not valid JSON."); }
    show(await Sahra.post("/api/tickets/form", { form: form }));
  });

  function csvCell(v) {
    var s = v === null || v === undefined ? "" : String(v);
    // Spreadsheet formula injection: cells starting with = + - @ are prefixed.
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function when(ms) { return ms ? new Date(ms).toISOString() : ""; }
  document.getElementById("export").addEventListener("click", async function () {
    var rows = [];
    var after = "";
    for (var page = 0; page < 50; page++) {
      var r = await get("/api/tickets/export?limit=500" + (after ? "&after=" + after : ""));
      if (r.status !== 200) return show(r);
      rows = rows.concat(r.body.tickets);
      if (!r.body.next) break;
      after = r.body.next;
    }
    var keys = {};
    rows.forEach(function (t) { Object.keys(t.answers || {}).forEach(function (k) { keys[k] = true; }); });
    var qs = Object.keys(keys);
    var head = ["ticket", "status", "name", "email", "people", "requested", "approved", "approved by", "rejected", "rejected by",
      "reason", "QR sent", "QR sent by", "scanned", "scanned by"].concat(qs);
    var lines = [head.map(csvCell).join(",")];
    rows.forEach(function (t) {
      lines.push([t.id, t.status, t.guest_name, t.guest_email, t.people, when(t.created_at), when(t.approved_at), t.approved_by,
        when(t.rejected_at), t.rejected_by, t.reject_reason, when(t.released_at), t.released_by, when(t.used_at), t.scanned_by]
        .concat(qs.map(function (q) { return (t.answers || {})[q]; })).map(csvCell).join(","));
    });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([lines.join("\r\n")], { type: "text/csv" }));
    a.download = "guests.csv";
    a.click();
    show("Exported " + rows.length + " tickets.");
  });

  Sahra.me().then(async function (m) {
    if (!m) return show("Sign in first.");
    document.getElementById("party-id").textContent = m.party.id;
    var f = await get("/api/tickets/form");
    if (f.status === 200) document.getElementById("form").value = JSON.stringify(f.body.form, null, 2);
    load(false);
  });
})();
