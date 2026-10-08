// Bare site owner / organiser test page.
"use strict";
(async function () {
  var csrf = "";
  var out = document.getElementById("out");
  function show(x) { out.textContent = JSON.stringify(x, null, 2); }
  async function get(path) {
    var r = await fetch(path, { credentials: "same-origin" });
    return r.json().catch(function () { return {}; });
  }
  async function post(path, body) {
    var r = await fetch(path, {
      method: "POST", credentials: "same-origin",
      headers: { "content-type": "application/json", "x-sahra-csrf": csrf },
      body: JSON.stringify(body || {}),
    });
    return { status: r.status, body: await r.json().catch(function () { return {}; }) };
  }
  // Retries an action that came back "pending" (change not yet recorded) with the same body.
  async function act(path, body) {
    for (var i = 0; i < 5; i++) {
      var r = await post(path, body);
      if (r.status !== 503) return r;
      await new Promise(function (ok) { setTimeout(ok, 1500); });
    }
    return r;
  }
  function form(id, fn) {
    document.getElementById(id).addEventListener("submit", async function (e) {
      e.preventDefault();
      await fn(new FormData(e.target));
    });
  }

  var r = await fetch("/api/platform/me", { credentials: "same-origin" });
  if (!r.ok) { document.getElementById("signin").hidden = false; return; }
  var me = await r.json();
  csrf = me.csrf;
  document.getElementById("signedin").hidden = false;
  document.getElementById("me").textContent = JSON.stringify(me, null, 2);
  document.getElementById("account").textContent = (me.site_owner || me.organiser).name + (me.site_owner ? " (site owner)" : " (organiser)");
  document.getElementById("logout").addEventListener("click", async function () {
    await post("/api/platform/logout");
    location.href = "/platform";
  });

  if (me.site_owner) {
    document.getElementById("site_owner").hidden = false;
    var loadHealth = async function () {
      var h = await get("/api/platform/health");
      if (!h || !h.checks) { document.getElementById("health").textContent = JSON.stringify(h, null, 2); return; }
      var t = (h.last_run_at ? "Last run: " + new Date(h.last_run_at).toISOString() : "The checks have not run yet") + "\n\n";
      h.checks.forEach(function (c) { t += (c.status === "problem" ? "PROBLEM  " : c.status === "ok" ? "ok       " : "not set  ") + c.title + ": " + c.summary + "\n"; });
      t += "\nRows written today (estimate): " + h.usage.estimated_rows_written_today + " of " + h.usage.daily_allowance
        + "; guest notices, email approvals and exports stop at " + h.usage.non_essential_stop_at + "\n";
      var d = h.discord || {};
      t += "\nDiscord: " + (d.status === "configured" ? "configured" : d.status === "invalid" ? "NOT USED (DISCORD_WEBHOOK_URL is not a Discord webhook URL)" : "not set")
        + (d.latest ? "; latest message " + new Date(d.latest.created_at).toISOString() + " " + d.latest.status + (d.latest.last_error ? " (" + d.latest.last_error + ")" : "") : "")
        + (d.messages && d.messages.pending ? "; " + d.messages.pending + " waiting to be posted" : "") + "\n";
      t += "\nRecent alerts:\n";
      h.alerts.forEach(function (a) { t += "  " + new Date(a.at).toISOString() + "  " + a.subject + "  " + JSON.stringify(a.statuses) + "\n"; });
      t += "\nPer-party counters today (limits per party per UTC day):\n";
      h.party_usage_today.forEach(function (u) { t += "  " + u.party_id + "  " + u.kind + "  " + u.n + " of " + h.limits[u.kind].cap + "\n"; });
      document.getElementById("health").textContent = t;
    };
    loadHealth();
    document.getElementById("health-refresh").addEventListener("click", loadHealth);
    var loadOwner = async function () {
      document.getElementById("organisers").textContent = JSON.stringify(await get("/api/platform/organisers"), null, 2);
      document.getElementById("parties").textContent = JSON.stringify(await get("/api/platform/parties"), null, 2);
      document.getElementById("owners").textContent = JSON.stringify(await get("/api/platform/site-owners"), null, 2);
    };
    loadOwner();
    form("invite", async function (f) {
      show(await act("/api/platform/organisers", { organiser_id: crypto.randomUUID(), invite_id: crypto.randomUUID(), name: f.get("name"), email: f.get("email") }));
      loadOwner();
    });
    form("disable-org", async function (f) {
      if (!confirm("Switch off this organiser? They lose platform access and stop managing their parties (the parties keep running).")) return;
      show(await act("/api/platform/organisers/" + encodeURIComponent(String(f.get("id")).trim()) + "/disable"));
      loadOwner();
    });
    form("limit", async function (f) {
      show(await act("/api/platform/organisers/" + encodeURIComponent(String(f.get("id")).trim()) + "/party-limit", { limit: Number(f.get("limit")) }));
      loadOwner();
    });
    form("manage-party", async function (f) {
      var r = await act("/api/platform/parties/" + encodeURIComponent(String(f.get("id")).trim()) + "/manage");
      if (r.status === 200) { location.href = "/dashboard"; return; }
      show(r);
    });
    form("owner-invite", async function (f) {
      show(await act("/api/platform/parties/" + encodeURIComponent(String(f.get("id")).trim()) + "/owner-invite", {
        staff_id: crypto.randomUUID(), invite_id: crypto.randomUUID(), name: f.get("name"), email: f.get("email"),
      }));
      loadOwner();
    });
    form("enable-party", async function (f) {
      show(await act("/api/platform/parties/" + encodeURIComponent(String(f.get("id")).trim()) + "/enable"));
      loadOwner();
    });
    form("remove-owner", async function (f) {
      if (!confirm("Remove this site owner? Their platform sessions end.")) return;
      show(await act("/api/platform/site-owners/" + encodeURIComponent(String(f.get("id")).trim()) + "/remove"));
      loadOwner();
    });
    form("disable-party", async function (f) {
      if (!confirm("Disable this party? Admission pauses and every staff session and invitation ends.")) return;
      show(await act("/api/platform/parties/" + encodeURIComponent(String(f.get("id")).trim()) + "/disable"));
      loadOwner();
    });
  }

  if (me.organiser) {
    document.getElementById("organiser").hidden = false;
    var loadMine = async function () {
      document.getElementById("myparties").textContent = JSON.stringify(await get("/api/platform/my-parties"), null, 2);
    };
    loadMine();
    var staffId = crypto.randomUUID();
    form("create", async function (f) {
      show(await act("/api/platform/parties", { id: f.get("id"), name: f.get("name"), capacity: Number(f.get("capacity")), staff_id: staffId }));
      staffId = crypto.randomUUID();
      loadMine();
    });
  }
})();
