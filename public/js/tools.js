// Team: /tools.html (party owners). Who runs the party with you: owners and
// admins sign in with Google (invited by their Gmail address); door staff join
// from a link opened on the phone they scan with (no account). Change a role,
// switch someone off, take back an invitation. Every rule (for example, the
// last owner cannot be switched off) is checked by the server.
"use strict";
(function () {
  var t = Sahra.t, el = Sahra.el, S = SahraStaff;
  var data = null, failed = null, me = null;
  var notes = {};           // staff or invite id -> [cls, text]
  var doorLink = null;      // { name, link, expires } after creating a door link
  var pending = {};         // form key -> ids kept until confirmed (a retry is the same invitation)

  function idsFor(key) { return pending[key] || (pending[key] = { staff_id: crypto.randomUUID(), invite_id: crypto.randomUUID(), token: Sahra.token() }); }

  async function load() {
    var r = await Sahra.api.get("/api/staff");
    if (!r.ok) failed = r; else { failed = null; data = r.body; }
    S.redraw();
  }

  function roleName(r) { return t("tm_role_" + r); }

  async function run(id, path, body, confirmText, done) {
    if (confirmText && !window.confirm(confirmText)) return;
    var r = await S.act(path, body || {});
    notes[id] = r.ok ? ["yes", done] : ["no", r.body && r.body.error === "not_allowed" ? t("tm_not_allowed") : S.why(r)];
    await load();
  }

  function invitesOf(staffId) {
    return (data.invites || []).filter(function (i) { return i.staff_id === staffId && !i.used_at && !i.revoked_at && i.expires_at > Date.now(); });
  }

  function personRow(s) {
    var open = invitesOf(s.id);
    var self = me && s.id === me.staff.id;
    var joined = self || s.linked || (data.invites || []).some(function (i) { return i.staff_id === s.id && i.used_at; });
    var state = s.disabled_at ? ["no", t("tm_off")] : joined ? ["yes", s.role === "door" ? t("tm_joined") : t("tm_signed_up")]
      : open.length ? ["maybe", s.role === "door" ? t("tm_link_open") : t("tm_invited")] : ["", t("tm_no_invite")];
    var acts = [];
    if (!s.disabled_at && !self) {
      if (s.role === "admin") acts.push(el("button", { class: "btn small-btn", text: t("tm_make_owner"), attrs: { type: "button" }, on: { click: function () {
        run(s.id, "/api/staff/" + s.id + "/role", { role: "owner" }, t("tm_make_owner_confirm", { name: s.name }), t("tm_role_done"));
      } } }));
      if (s.role === "owner") acts.push(el("button", { class: "btn small-btn", text: t("tm_make_admin"), attrs: { type: "button" }, on: { click: function () {
        run(s.id, "/api/staff/" + s.id + "/role", { role: "admin" }, null, t("tm_role_done"));
      } } }));
      if (s.role === "door") acts.push(el("button", { class: "btn small-btn", text: t("tm_new_link"), attrs: { type: "button" }, on: { click: function () { doorInvite(s); } } }));
      acts.push(el("button", { class: "btn no small-btn", text: t("tm_disable"), attrs: { type: "button" }, on: { click: function () {
        run(s.id, "/api/staff/" + s.id + "/disable", {}, t("tm_disable_confirm", { name: s.name }), t("tm_disabled_done"));
      } } }));
    }
    open.forEach(function (i) {
      acts.push(el("button", { class: "btn link danger", text: t("tm_revoke"), attrs: { type: "button" }, on: { click: function () {
        run(s.id, "/api/invites/" + i.id + "/revoke", {}, t("tm_revoke_confirm"), t("tm_revoked_done"));
      } } }));
    });
    var line = [roleName(s.role), s.invited_email, open.length ? t("tm_invite_until", { when: Sahra.when(open[0].expires_at) }) : null].filter(Boolean).join(" · ");
    var li = el("li", { class: "g-row" + (s.disabled_at ? " off" : "") },
      el("div", { class: "g-who" },
        el("div", { class: "g-name-line" }, el("strong", { text: s.name + (self ? " (" + t("tm_you") + ")" : ""), attrs: { dir: "auto" } }), el("span", { class: "pill " + state[0], text: state[1] })),
        el("span", { class: "muted small", text: line, attrs: { dir: "auto" } })),
      acts.length ? el("div", { class: "g-actions" }, acts) : null);
    if (notes[s.id]) { var box = S.sayBox(); S.say(box, notes[s.id][0], notes[s.id][1]); li.appendChild(el("div", { class: "g-note" }, box)); delete notes[s.id]; }
    return li;
  }

  function teamCard() {
    if (failed) return S.section("team", t("tm_team"), null, el("p", { class: "notice no", text: S.why(failed) }));
    if (!data) return S.section("team", t("tm_team"), null, el("p", { class: "muted", text: t("loading") }));
    var order = { owner: 0, admin: 1, door: 2 };
    var list = data.staff.slice().sort(function (a, b) { return (a.disabled_at ? 1 : 0) - (b.disabled_at ? 1 : 0) || order[a.role] - order[b.role]; });
    return S.section("team", t("tm_team"), t("tm_team_p"), el("ul", { class: "g-list" }, list.map(personRow)));
  }

  // ------------------------------------------------------------- invitations

  async function doorInvite(existing, f, box) {
    var key = existing ? "door:" + existing.id : "door";
    var ids = idsFor(key);
    var hours = f ? Number(f.elements.hours.value) : 72;
    var name = existing ? existing.name : f.elements.name.value.trim();
    if (!name) { S.say(box, "no", t("s_name_needed")); return; }
    var r = await S.act("/api/staff/door-invite", { staff_id: existing ? existing.id : ids.staff_id, invite_id: ids.invite_id,
      name: existing ? null : name, token: ids.token, hours: hours });
    if (r.status !== 503) delete pending[key];
    if (!r.ok) { if (box) S.say(box, "no", S.why(r)); else notes[existing.id] = ["no", S.why(r)]; await load(); return; }
    doorLink = { name: name, link: location.origin + "/join#t=" + ids.token, expires: r.body.expires_at };
    if (f) f.reset();
    await load();
    var n = document.getElementById("door-link");
    if (n) n.scrollIntoView({ block: "center" });
  }

  function doorCard() {
    var box = S.sayBox();
    var f = el("form", { attrs: { novalidate: true } },
      el("div", { class: "s-two" },
        S.field(t("tm_door_name"), S.input("name", "text", { maxlength: 80, dir: "auto" })),
        S.field(t("tm_valid"), S.select("hours", [["12", t("tm_h12")], ["24", t("tm_h24")], ["72", t("tm_h72")], ["168", t("tm_h168")]], "72"), t("tm_valid_h"))),
      el("div", { class: "s-save" }, el("button", { class: "btn primary small-btn", text: t("tm_door_go"), attrs: { type: "submit" } }), box));
    f.addEventListener("submit", function (e) { e.preventDefault(); doorInvite(null, f, box); });
    var made = doorLink ? el("div", { class: "notice yes tm-link", attrs: { id: "door-link" } },
      el("strong", { text: t("tm_link_for", { name: doorLink.name }) }),
      el("p", { class: "small", text: t("tm_link_h", { when: Sahra.when(doorLink.expires) }) }),
      el("div", { class: "g-link" }, el("code", { text: doorLink.link, attrs: { dir: "ltr" } }), S.copyButton(doorLink.link, t("g_copy_link")))) : null;
    return S.section("door", t("tm_add_door"), t("tm_add_door_p"), made, f);
  }

  function googleCard() {
    var box = S.sayBox();
    var f = el("form", { attrs: { novalidate: true } },
      el("div", { class: "s-two" },
        S.field(t("tm_name"), S.input("name", "text", { maxlength: 80, dir: "auto" })),
        S.field(t("tm_gmail"), S.input("email", "email", { dir: "ltr", autocomplete: "off" }), t("tm_gmail_h"))),
      S.field(t("tm_role"), S.select("role", [["admin", t("tm_role_admin_long")], ["owner", t("tm_role_owner_long")]], "admin")),
      el("div", { class: "s-save" }, el("button", { class: "btn primary small-btn", text: t("tm_invite_go"), attrs: { type: "submit" } }), box));
    f.addEventListener("submit", async function (e) {
      e.preventDefault();
      var name = f.elements.name.value.trim(), email = f.elements.email.value.trim();
      if (!name || !email) { S.say(box, "no", t("tm_name_email")); return; }
      var ids = idsFor("google");
      var r = await S.act("/api/staff/google-invite", { staff_id: ids.staff_id, invite_id: ids.invite_id, name: name, email: email, role: f.elements.role.value });
      if (r.status !== 503) delete pending.google;
      if (!r.ok) { S.say(box, "no", r.body && r.body.error === "not_allowed_or_already_invited" ? t("tm_already") : S.why(r)); return; }
      notes.google = ["yes", t("tm_invited_done", { email: r.body.email })];
      f.reset();
      await load();
    });
    var card = S.section("invite", t("tm_invite"), t("tm_invite_p"), f);
    if (notes.google) { S.say(box, notes.google[0], notes.google[1]); delete notes.google; }
    return card;
  }

  function render(m, app) {
    me = m;
    app.appendChild(el("div", { class: "g-cols" },
      el("div", { class: "g-main" }, teamCard()),
      el("div", { class: "g-side" }, doorCard(), googleCard())));
  }

  var first = true;
  SahraStaff.start({
    page: "team", title: "tm_title", lede: "tm_lede", owner: true,
    render: function (m, app) {
      render(m, app);
      if (first) { first = false; load(); }
    },
  });
})();
