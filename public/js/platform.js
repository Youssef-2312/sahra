// My parties (party owners who create parties) and the site-owner panel, at /platform.
// One sign-in for everyone (Sahra.signinView); each party opens from here without
// signing in again (POST /api/platform/parties/:id/open). Platform authentication and CSRF are separate
// from party sessions: never call Sahra.api.me() or SahraStaff.start() here.
// Retry bodies (including invitation / staff UUIDs) stay fixed until confirmed.
"use strict";
(async function () {
  var t = Sahra.t, el = Sahra.el, S = SahraStaff;
  var app = document.getElementById("app"), me = null, authError = null;
  var data = {}, failures = {}, loading = {}, pending = {}, notes = {}, busy = {};
  var headers = {};

  function label(key, fallback) { return SahraText.en[key] ? t(key) : fallback || t("p_unknown"); }
  function pill(status) {
    var cls = { ok: "yes", active: "yes", problem: "no", disabled: "no", unknown: "maybe", pending: "maybe", paused: "maybe", reconciling: "maybe" };
    return el("span", { class: "pill " + (cls[status] || ""), text: label("p_state_" + status) });
  }
  function button(key, fn, cls) { return el("button", { class: "btn small-btn " + (cls || ""), text: t(key), attrs: { type: "button" }, on: { click: fn } }); }
  function detail(key, value) { return el("div", null, el("dt", { text: t(key) }), el("dd", { text: value, attrs: { dir: "auto" } })); }
  function notice(key) {
    var n = notes[key], box = S.sayBox();
    if (n) S.say(box, n.ok ? "yes" : "no", n.ok ? t(n.key) : why(n.result));
    var request = pending[key];
    if (request && key !== "invite" && key !== "create" && !/:limit$|:invite$/.test(key)) {
      return el("div", null, box, button("p_retry_action", function () {
        return act(key, request.path, request.body, request.refresh, request.success, null, request.redirect);
      }));
    }
    return box;
  }
  function why(r) {
    var key = "p_e_" + (r.body && r.body.error);
    return SahraText.en[key] ? t(key) : S.why(r);
  }
  var paths = { health: "/health", organisers: "/organisers", parties: "/parties", owners: "/site-owners", mine: "/my-parties", teams: "/teams" };
  async function load(key) {
    if (loading[key]) return;
    loading[key] = true;
    var r = await Sahra.api.get("/api/platform" + paths[key]);
    loading[key] = false;
    if (r.ok) { data[key] = r.body; delete failures[key]; }
    else failures[key] = r;
    render();
  }
  function content(key, build) {
    if (failures[key]) return el("div", { class: "notice no" }, el("p", { text: why(failures[key]) }), button("p_retry", function () { load(key); }));
    if (!data[key]) return el("p", { class: "muted", text: t("loading"), attrs: { role: "status" } });
    return build(data[key]);
  }
  function empty(key) { return el("p", { class: "s-empty", text: t(key) }); }

  // While the outcome is uncertain, keep the complete request, not just its ids.
  // Prevent concurrent clicks, and lock a form until that request is confirmed.
  async function act(key, path, body, refresh, success, confirmKey, redirect) {
    if (busy[key] || (pending[key] && pending[key].path !== path)) return;
    if (!pending[key] && confirmKey && !window.confirm(t(confirmKey))) return;
    var request = pending[key] || { path: path, body: body || {}, refresh: refresh, success: success, redirect: redirect };
    pending[key] = request;
    busy[key] = true;
    var r;
    try {
      for (var i = 0; i < 5; i++) {
        r = await Sahra.api.post(request.path, request.body, headers);
        if (r.status !== 503) break;
        await S.sleep(1500);
      }
    } finally { busy[key] = false; }
    // Network errors, pending writes and server errors can have applied the change.
    if (r.ok || (r.status >= 400 && r.status < 500)) delete pending[key];
    notes[key] = r.ok ? { ok: true, key: success || "s_saved" } : { ok: false, result: r };
    if (r.ok && redirect) {
      if (redirect === "/dashboard") Sahra.store.set(Sahra.SESSION_KEY, "party");
      if (key === "logout") Sahra.store.del(Sahra.SESSION_KEY);
      location.href = redirect; return;
    }
    if (refresh) await load(refresh); else render();
    return r;
  }
  function action(key, path, body, refresh, success, confirmKey, text, cls, redirect) {
    var control = button(text, async function (e) {
      var b = e.currentTarget; b.disabled = true;
      try { await act(key, path, body, refresh, success, confirmKey, redirect); }
      finally { b.disabled = false; }
    }, cls);
    control.disabled = !!busy[key] || !!pending[key];
    return control;
  }
  function form(key, fields, submitKey, send) {
    var f = el("form", { class: "s-platform-form", attrs: { "data-form": key } });
    var group = el("fieldset", null, fields);
    var submit = el("button", { class: "btn primary small-btn", text: t(pending[key] ? "p_retry_action" : submitKey), attrs: { type: "submit", disabled: !!busy[key] } });
    if (pending[key]) {
      Array.from(group.querySelectorAll("input")).forEach(function (input) {
        var value = pending[key].body[input.name];
        if (value !== undefined) input.value = value;
      });
      group.disabled = true;
    }
    f.addEventListener("input", function () { delete notes[key]; });
    f.append(group, el("div", { class: "s-save" }, submit), notice(key));
    f.addEventListener("submit", async function (e) {
      e.preventDefault();
      if (busy[key]) return;
      var values = Object.fromEntries(new FormData(f));
      submit.disabled = true;
      group.disabled = true;
      try { await send(values); }
      finally { submit.disabled = false; if (!pending[key]) group.disabled = false; }
    });
    return f;
  }
  function nameEmail() {
    return el("div", { class: "s-two" },
      S.field(t("tm_name"), S.input("name", "text", { required: true, maxlength: 80, dir: "auto", autocomplete: "off" })),
      S.field(t("tm_gmail"), S.input("email", "email", { required: true, dir: "ltr", autocomplete: "off", pattern: "[^@]+@(?:gmail\\.com|googlemail\\.com)" }), t("tm_gmail_h")));
  }
  function counts(values) {
    return Object.keys(values || {}).map(function (status) { return label("p_state_" + status) + ": " + values[status]; }).join(" · ") || t("p_none");
  }

  function health(h) {
    var checks = ["changelog", "admissions", "outbox", "db_size", "backup", "usage"].map(function (id) {
      var c = (h.checks || []).find(function (row) { return row.id === id; });
      var status = c ? c.status : "unknown";
      return el("li", { class: "g-row" },
        el("div", { class: "g-name-line" }, el("strong", { text: t("p_check_" + id) }), pill(status)),
        el("p", { class: "muted", text: t("p_check_" + id + "_" + status) }),
        c ? el("p", { class: "small muted", text: t("p_checked", { when: Sahra.when(c.checked_at) }) }) : null,
        c && c.summary ? el("details", { class: "s-platform-details" }, el("summary", { text: t("p_report") }),
          el("p", { text: c.summary, attrs: { dir: "auto", lang: "en" } })) : null);
    });
    var d = h.discord || {}, latest = d.latest;
    return el("div", null,
      el("div", { class: "g-actions" }, button("p_refresh_health", function () { load("health"); })),
      el("p", { class: "muted small", text: h.last_run_at ? t("p_last_run", { when: Sahra.when(h.last_run_at) }) : t("p_never_run") }),
      el("ul", { class: "g-list s-health-grid" }, checks),
      el("h3", { text: t("p_usage") }),
      el("p", { text: t("p_usage_value", { n: h.usage.estimated_rows_written_today, max: h.usage.daily_allowance }) }),
      el("p", { class: "muted small", text: t("p_usage_stop", { n: h.usage.non_essential_stop_at }) }),
      el("h3", { text: t("p_discord") }),
      el("p", { text: label("p_discord_" + d.status) }),
      el("p", { class: "muted", text: counts(d.messages) }),
      latest ? el("p", { text: t("p_latest_message", { when: Sahra.when(latest.created_at), status: label("p_state_" + latest.status) }) }) : null,
      latest && latest.last_error ? el("p", { class: "o-error", text: latest.last_error, attrs: { dir: "auto" } }) : null,
      el("details", { class: "s-platform-details" }, el("summary", { text: t("p_alerts") }),
        h.alerts.length ? el("ul", { class: "g-list" }, h.alerts.map(function (a) {
          return el("li", { class: "g-row" }, el("strong", { text: a.subject, attrs: { dir: "auto" } }),
            el("p", { class: "muted small", text: Sahra.when(a.at) }), el("p", { text: counts(a.statuses) }));
        })) : empty("p_no_alerts")),
      el("details", { class: "s-platform-details" }, el("summary", { text: t("p_party_usage") }),
        h.party_usage_today.length ? el("ul", { class: "g-list" }, h.party_usage_today.map(function (u) {
          return el("li", { class: "g-row" }, el("strong", { text: u.party_id, attrs: { dir: "auto" } }),
            el("p", { text: label("p_limit_" + u.kind) + ": " + u.n + " / " + (h.limits[u.kind] ? h.limits[u.kind].cap : t("p_unknown")) }));
        })) : empty("p_no_usage")));
  }

  function organisers(o) {
    return el("div", null, o.organisers.length ? el("ul", { class: "g-list" }, o.organisers.map(function (person) {
      var key = "org:" + person.id, path = "/api/platform/organisers/" + encodeURIComponent(person.id);
      var invitation = o.invites.find(function (i) { return i.organiser_id === person.id && !i.used_at && !i.revoked_at && i.expires_at > Date.now(); });
      return el("li", { class: "g-row" },
        el("div", { class: "g-name-line" }, el("strong", { text: person.name, attrs: { dir: "auto" } }), pill(person.disabled_at ? "disabled" : person.linked ? "active" : "pending")),
        el("p", { class: "muted s-platform-wrap", text: person.email, attrs: { dir: "ltr" } }),
        el("p", { text: t("p_party_count", { n: person.active_parties, max: person.party_limit }) }),
        invitation ? el("p", { class: "muted small", text: t("tm_invite_until", { when: Sahra.when(invitation.expires_at) }) }) : null,
        !person.disabled_at ? el("details", { class: "s-platform-details" }, el("summary", { text: t("p_manage_organiser") }),
          form(key + ":limit", S.field(t("p_party_limit"), S.input("limit", "number", { required: true, min: 1, max: 20, step: 1, value: person.party_limit })), "s_save", function (v) {
            return act(key + ":limit", path + "/party-limit", { limit: Number(v.limit) }, "organisers");
          }),
          action(key, path + "/disable", {}, "organisers", "p_organiser_disabled", "p_confirm_organiser", "p_disable_organiser", "no")) : null,
        notice(key));
    })) : empty("p_no_organisers"),
    el("h3", { text: t("p_invite_organiser") }),
    form("invite", nameEmail(), "p_invite_organiser", function (v) {
      return act("invite", "/api/platform/organisers", { organiser_id: crypto.randomUUID(), invite_id: crypto.randomUUID(), name: v.name, email: v.email }, "organisers", "p_invited");
    }));
  }

  var disabling = {};
  function disablePanel(p, key, path) {
    var tk = p.tickets || {}, approved = Number(tk.approved || 0), pendingN = Number(tk.pending || 0);
    var typed = el("input", { attrs: { type: "text", autocomplete: "off", dir: "auto", "aria-label": t("p_disable_type", { name: p.name }) } });
    var go = el("button", { class: "btn no small-btn", text: t("p_disable_go"), attrs: { type: "button", disabled: true } });
    typed.addEventListener("input", function () { go.disabled = typed.value.trim() !== String(p.name).trim(); });
    go.addEventListener("click", async function () {
      go.disabled = true;
      await act(key, path + "/disable", {}, "parties", "p_party_disabled", null);
      disabling[key] = false;
      render();
    });
    return el("div", { class: "notice no s-disable" },
      el("strong", { text: t("p_disable_title") }),
      el("ul", null,
        el("li", { text: t("p_disable_req") }),
        el("li", { text: t("p_disable_adm", { n: approved }) }),
        pendingN ? el("li", { text: t("p_disable_pending", { n: pendingN }) }) : null,
        el("li", { text: t("p_disable_sessions", { n: Number(p.active_sessions || 0) }) })),
      el("label", { class: "small", text: t("p_disable_type", { name: p.name }) }), typed,
      el("div", { class: "g-actions" }, go, button("q_cancel", function () { disabling[key] = false; render(); }, "")));
  }

  function teamRow(m) {
    var key = "open:" + m.party_id;
    return el("li", { class: "g-row" },
      el("div", { class: "g-name-line" }, el("strong", { text: m.party_name, attrs: { dir: "auto" } }), el("span", { class: "pill", text: t("nt_role_" + m.role) })),
      el("p", { class: "muted small", text: m.party_id, attrs: { dir: "ltr" } }),
      el("div", { class: "g-actions" }, action(key, "/api/platform/parties/" + encodeURIComponent(m.party_id) + "/open", {}, null, null, null, "p_open_party", "primary", "/dashboard")),
      notice(key));
  }
  function partyRow(p, siteOwner) {
    var key = "party:" + p.id, path = "/api/platform/parties/" + encodeURIComponent(p.id);
    var acts = [];
    if (siteOwner) {
      if (!p.disabled_at) acts.push(action(key, path + "/manage", {}, null, null, null, "p_manage_party", "", "/dashboard"));
      // Brainstorm idea 19: disabling is a labelled, confirmed action that says what it does, in numbers,
      // and asks for the party's name; turning it back on is one clear action with a short explanation.
      if (p.disabled_at) acts.push(action(key, path + "/enable", {}, "parties", "p_party_enabled", "p_confirm_enable", "p_enable_party", ""));
      else acts.push(button("p_disable_open", function () { disabling[key] = !disabling[key]; render(); }, "no"));
    }
    var li = el("li", { class: "g-row" },
      el("div", { class: "g-name-line" }, el("strong", { text: p.name, attrs: { dir: "auto" } }), pill(p.disabled_at ? "disabled" : p.admission_state)),
      el("p", { class: "muted small", text: p.id, attrs: { dir: "ltr" } }),
      el("dl", { class: "s-platform-facts" }, detail("p_capacity", p.capacity),
        siteOwner ? [detail("p_organiser", p.organiser_name || t("p_none")), detail("p_staff", p.staff), detail("p_sessions", p.active_sessions),
          detail("p_tickets", counts(p.tickets)), detail("p_emails", counts(p.outbox))] : null),
      acts.length ? el("div", { class: "g-actions" }, acts) : null, notice(key));
    if (siteOwner && !p.disabled_at && disabling[key]) li.appendChild(disablePanel(p, key, path));
    if (siteOwner && p.no_active_owner) {
      li.appendChild(el("p", { class: "notice maybe", text: t("p_no_owner", { n: p.pending_owner_invites }) }));
      if (!p.disabled_at) li.appendChild(el("details", { class: "s-platform-details" }, el("summary", { text: t("p_invite_owner") }),
        form(key + ":invite", nameEmail(), "p_invite_owner", function (v) {
          return act(key + ":invite", path + "/owner-invite", { staff_id: crypto.randomUUID(), invite_id: crypto.randomUUID(), name: v.name, email: v.email }, "parties", "p_invited");
        })));
    }
    return li;
  }
  function owners(o) {
    return o.site_owners.length ? el("ul", { class: "g-list" }, o.site_owners.map(function (person) {
      var key = "owner:" + person.id;
      return el("li", { class: "g-row" },
        el("div", { class: "g-name-line" }, el("strong", { text: person.name, attrs: { dir: "auto" } }), pill(person.disabled_at ? "disabled" : person.linked ? "active" : "pending")),
        el("p", { class: "muted s-platform-wrap", text: person.email, attrs: { dir: "ltr" } }),
        person.id === me.site_owner.id ? el("p", { class: "muted small", text: t("tm_you") }) : !person.disabled_at ?
          action(key, "/api/platform/site-owners/" + encodeURIComponent(person.id) + "/remove", {}, "owners", "p_owner_removed", "p_confirm_owner", "p_remove_owner", "no") : null,
        notice(key));
    })) : empty("p_no_owners");
  }
  // The name on the sign-in button and in your teams (owner: a normal name, not the Gmail address).
  function yourName() {
    var who = me.site_owner || me.organiser;
    return form("myname", [S.field(t("p_your_name"), S.input("name", "text", { required: true, maxlength: 80, dir: "auto", value: who.name.indexOf("@") > 0 ? "" : who.name, autocomplete: "name" }), t("p_your_name_hint"))], "s_save", function (v) {
      if (v.name.indexOf("@") >= 0) { notes.myname = { ok: false, result: { status: 400, body: { error: "name_is_email" } } }; render(); return; }
      return act("myname", "/api/platform/me/name", { name: v.name }, null, "p_name_saved", null, "/platform");
    });
  }
  function createParty() {
    return form("create", [S.field(t("p_party_id"), S.input("id", "text", { required: true, minlength: 3, maxlength: 24, pattern: "[a-z0-9][a-z0-9\\-]{1,22}[a-z0-9]", dir: "ltr", autocapitalize: "none", spellcheck: "false" }), t("p_party_id_hint")),
      S.field(t("s_name"), S.input("name", "text", { required: true, maxlength: 80, dir: "auto" })),
      S.field(t("p_capacity"), S.input("capacity", "number", { required: true, min: 1, max: 100000, step: 1, value: 100 }))], "p_create", function (v) {
        return act("create", "/api/platform/parties", { id: v.id, name: v.name, capacity: Number(v.capacity), staff_id: crypto.randomUUID() }, "teams", "p_created");
      });
  }

  function render() {
    // Preserve unsent edits and open details through background loads and language changes.
    var drafts = {}, open = Array.from(app.querySelectorAll("details")).map(function (d) { return d.open; });
    app.querySelectorAll("form[data-form]").forEach(function (f) {
      drafts[f.dataset.form] = Array.from(f.querySelectorAll("input")).map(function (i) { return [i.name, i.value]; });
    });
    Sahra.clear(app);
    Sahra.title(t(me && me.site_owner ? "p_site_owner" : "p_title"));
    if (!me) {
      Sahra.title(t("si_title"));
      app.appendChild(Sahra.signinView(authError && authError.status !== 401
        ? el("div", { class: "notice no" }, el("p", { text: why(authError) }), button("p_retry", function () { location.reload(); })) : null));
      return;
    }
    var navItems = [["mine", "p_my_parties"]];
    if (me.organiser) navItems.push(["create", "p_create"]);
    if (me.site_owner) navItems.push(["health", "p_health"], ["organisers", "p_organisers"], ["parties", "p_parties"], ["owners", "p_site_owners"]);
    app.appendChild(el("nav", { class: "staff-nav", attrs: { "aria-label": t("p_nav") } }, navItems.map(function (n) { return el("a", { text: t(n[1]), attrs: { href: "#" + n[0] } }); }),
      action("logout", "/api/platform/logout", {}, null, null, null, "s_sign_out", "staff-out", "/platform")));
    app.appendChild(el("header", { class: "staff-head" }, el("div", null,
      el("p", { class: "label-line", text: (me.site_owner || me.organiser).name.split("@")[0], attrs: { dir: "auto" } }),
      el("h1", { text: t(me.site_owner ? "p_site_owner" : "p_title") }),
      el("p", { class: "muted lede", text: t(me.site_owner ? "p_owner_intro" : "p_organiser_intro") }))));
    app.appendChild(notice("logout"));
    // My parties: every party this account runs, opened without signing in again; and a new one.
    app.appendChild(el("div", { class: "g-cols" },
      S.section("mine", t("p_my_parties"), t("p_mine_intro"), content("teams", function (d) {
        return d.teams.length ? el("ul", { class: "g-list" }, d.teams.map(teamRow)) : empty(me.organiser ? "p_no_parties_yet" : "p_no_parties");
      })),
      el("div", null, me.organiser ? S.section("create", t("p_create"), t("p_create_intro"), createParty()) : null,
        S.section("myname", t("p_your_name"), t("p_your_name_intro"), yourName()))));
    if (me.site_owner) {
      app.appendChild(S.section("health", t("p_health"), t("p_health_intro"), content("health", health)));
      app.appendChild(el("div", { class: "g-cols" },
        S.section("parties", t("p_parties"), t("p_parties_intro"), content("parties", function (d) { return d.parties.length ? el("ul", { class: "g-list" }, d.parties.map(function (p) { return partyRow(p, true); })) : empty("p_no_parties"); })),
        el("div", null, S.section("organisers", t("p_organisers"), t("p_organisers_intro"), content("organisers", organisers)),
          S.section("owners", t("p_site_owners"), t("p_owners_intro"), content("owners", owners)))));
    }
    app.querySelectorAll("form[data-form]").forEach(function (f) {
      // Clear successful submitted forms; keep other drafts on every redraw.
      if (notes[f.dataset.form] && notes[f.dataset.form].ok) return;
      (drafts[f.dataset.form] || []).forEach(function (pair) { var input = f.querySelector('[name="' + pair[0] + '"]'); if (input) input.value = pair[1]; });
    });
    app.querySelectorAll("details").forEach(function (d, i) { d.open = !!open[i]; });
  }

  var r = await Sahra.api.get("/api/platform/me");
  if (r.ok) { me = r.body; headers["x-sahra-csrf"] = me.csrf; Sahra.store.set(Sahra.SESSION_KEY, "platform"); }
  else { authError = r; if (r.status === 401) Sahra.store.del(Sahra.SESSION_KEY); }
  Sahra.boot({ render: render });
  if (me && me.site_owner) ["health", "organisers", "parties", "owners"].forEach(load);
  if (me) load("teams");
})();
