"use strict";
(function () {
  var msg = document.getElementById("msg");
  var btn = document.getElementById("join");
  // The invitation token is in the URL fragment (#t=...), which browsers never send to servers.
  var m = /[#&]t=([A-Za-z0-9_-]{43})/.exec(location.hash);
  var saved = Sahra.store.get("sahra_join");
  var state = saved ? JSON.parse(saved) : null;
  if (m && (!state || state.t !== m[1])) {
    // A fresh 256-bit value; it becomes this browser's session token. Saved so a retry can reuse it.
    state = { t: m[1], v: Sahra.token() };
    Sahra.store.set("sahra_join", JSON.stringify(state));
  }
  if (m) history.replaceState(null, "", "/join");
  if (!state) { msg.textContent = "No invitation in this link."; btn.disabled = true; return; }

  async function attempt(n) {
    btn.disabled = true;
    msg.textContent = "Joining...";
    var r;
    try {
      r = await fetch("/api/invites/consume", {
        method: "POST", credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: state.t, session: state.v }),
      });
    } catch (e) {
      if (n < 5) return setTimeout(function () { attempt(n + 1); }, 1500);
      msg.textContent = "Network error. Press Join again."; btn.disabled = false; return;
    }
    var j = await r.json().catch(function () { return {}; });
    if (r.status === 200) {
      Sahra.store.del("sahra_join");
      msg.textContent = "Joined as " + j.staff_name + ". You can now use the scanner.";
      // Door staff go straight to the scanner (Phase 5).
      setTimeout(function () { location.href = "/scan.html"; }, 800);
      return;
    }
    if (r.status === 503 && j.retry && n < 5) return setTimeout(function () { attempt(n + 1); }, 1500);
    msg.textContent = "Could not join: " + (j.error || r.status);
    btn.disabled = r.status === 503 ? false : true;
  }
  btn.addEventListener("click", function () { attempt(0); });
})();
