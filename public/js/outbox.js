"use strict";
(async function () {
  var out = document.getElementById("out");
  var tbody = document.getElementById("rows");
  var more = document.getElementById("more");
  var next = null;
  function show(x) { out.textContent = JSON.stringify(x, null, 2); }
  var me = await Sahra.me();
  if (!me) { location.href = "/"; return; }
  if (me.staff.role === "door") { show({ error: "owners and admins only" }); return; }

  function when(ms) { return ms ? new Date(ms).toLocaleString() : ""; }
  function cell(tr, text) { var td = document.createElement("td"); td.textContent = text == null ? "" : String(text); tr.appendChild(td); return td; }

  async function load(append) {
    var status = new FormData(document.getElementById("filter")).get("status");
    var q = new URLSearchParams();
    if (status) q.set("status", status);
    if (append && next) q.set("before", next);
    var r = await fetch("/api/outbox?" + q.toString(), { credentials: "same-origin" });
    var j = await r.json();
    if (!r.ok) { show(j); return; }
    if (!append) tbody.textContent = "";
    j.rows.forEach(function (row) {
      var tr = document.createElement("tr");
      var box = document.createElement("input");
      box.type = "checkbox";
      box.value = row.id;
      box.disabled = row.status !== "awaiting_approval" && row.status !== "queued";
      cell(tr, "").appendChild(box);
      cell(tr, when(row.created_at));
      cell(tr, row.status);
      cell(tr, row.to_email);
      cell(tr, row.subject);
      var pre = document.createElement("pre");
      pre.textContent = row.body_text;
      cell(tr, "").appendChild(pre);
      cell(tr, row.attempts);
      cell(tr, when(row.sent_at) + (row.provider ? " (" + row.provider + ")" : ""));
      cell(tr, row.last_error);
      tbody.appendChild(tr);
    });
    next = j.next;
    more.hidden = !next;
  }

  function selected() {
    return Array.prototype.map.call(tbody.querySelectorAll("input:checked"), function (b) { return b.value; });
  }
  async function act(path, body) {
    show(await Sahra.post(path, body));
    await load(false);
  }

  document.getElementById("filter").addEventListener("submit", function (e) { e.preventDefault(); load(false); });
  more.addEventListener("click", function () { load(true); });
  document.getElementById("approve-all").addEventListener("click", function () {
    if (confirm("Approve and send every email awaiting approval?")) act("/api/outbox/approve", { all_awaiting: true });
  });
  document.getElementById("cancel-all").addEventListener("click", function () {
    if (confirm("Cancel every email awaiting approval?")) act("/api/outbox/cancel", { all_awaiting: true });
  });
  document.getElementById("approve-sel").addEventListener("click", function () {
    var ids = selected();
    if (ids.length) act("/api/outbox/approve", { ids: ids });
  });
  document.getElementById("cancel-sel").addEventListener("click", function () {
    var ids = selected();
    if (ids.length) act("/api/outbox/cancel", { ids: ids });
  });
  load(false);
})();
