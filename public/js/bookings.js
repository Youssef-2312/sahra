// Shared booking view. Resolve every member from the server, not the visible
// status tab, search result or pagination. Never cache guest details locally.
"use strict";
(function () {
  var t = Sahra.t, el = Sahra.el, S = SahraStaff, ops = {}, busy = {};
  function path(id, action) { return "/api/tickets/" + encodeURIComponent(id) + "/" + action; }
  function state(m) {
    return t(m.used_at ? "g_st_inside" : m.status === "cancelled" ? (m.approved_at == null ? "bk_deleted" : "bk_position_cancelled") : m.status === "rejected" ? "g_st_rejected"
      : m.status === "pending" ? "g_st_pending" : m.on_hold ? "g_st_hold" : m.released_at ? "g_st_sent" : "g_st_approved");
  }
  function pendingCancel(m) { return m.status === "cancelled" && m.rev > m.logged_rev && m.last_action === "cancelled" && m.last_op; }
  function requestOnly(m) { return m.status === "pending" || m.status === "cancelled" && m.approved_at == null; }
  function wholeAction(data) { var active=data.members.filter(function(m){return m.status==="pending"||m.status==="approved";});
    return active.length && active.every(requestOnly) ? "bk_delete_all" : active.some(requestOnly) ? "bk_mixed_action" : "bk_cancel_all"; }
  function summary(b) {
    if(b.unconfirmed)return t("bk_not_confirmed");
    if(b.deleted===b.total)return t("bk_all_deleted");
    if(b.cancelled===b.total)return t("bk_all_cancelled");
    var counts=[[b.pending||0,"pending"],[Math.max(0,b.active-(b.pending||0)),"active"],[b.cancelled||0,"cancelled"],[b.deleted||0,"deleted"],[b.rejected||0,"rejected"],[b.used||0,"used"]];
    return t("bk_total_records",{n:b.total})+" · "+counts.filter(function(x){return x[0]>0;}).map(function(x){return t("bk_count_"+x[1]+(x[0]===1?"_one":""),{n:x[0]});}).join(" · ");
  }

  function guide() {
    return el("details", { class: "bk-guide" }, el("summary", { text: t("bk_guide") }),
      el("p", { text: t("bk_rule") }), el("p", { class: "muted", text: t("bk_guide_body") }));
  }
  function card(row, changed) {
    var b = row.booking, bookingId = b && b.id || row.order_id || row.id;
    var root = el("details", { class: "bk-card" });
    var head = el("summary", null, el("strong", { text: t("bk_details") }),
      b ? el("span", { class: "bk-summary", text: summary(b) }) : null);
    var body = el("div", { class: "bk-body" }), data = null, loading = false, readSeq = 0;
    root.append(head, body);
    function signal() {
      // Other open pages refresh on visibility/storage. No names, emails or IDs.
      try { localStorage.setItem("sahra_ticket_change", String(Date.now())); } catch (_) {}
      if (changed) changed();
    }
    async function read() {
      var seq = ++readSeq;
      loading = true; root.setAttribute("aria-busy", "true");
      var r = await Sahra.api.get(path(row.id, "booking"));
      if (seq !== readSeq) return;
      loading = false; root.removeAttribute("aria-busy");
      if (!r.ok) { data = null; Sahra.clear(body); body.appendChild(el("p", { class: "notice no", text: S.why(r) })); return; }
      data = r.body; draw();
    }
    async function cancel(member) {
      var key = member ? "one:" + member.id : "all:" + bookingId;
      if (busy[key]) return;
      busy[key] = true; draw();
      try {
        // Always refresh BEFORE confirmation. Revisions bind the confirmation
        // to exactly these members; a later change is refused by the server.
        var r = await Sahra.api.get(path(row.id, "booking"));
        if (!r.ok) { await Sahra.notify(S.why(r)); return; }
        data = r.body;
        var m = member && data.members.find(function (x) { return x.id === member.id; });
        if (member && (!m || m.used_at || (["pending", "approved"].indexOf(m.status) < 0 && !ops[key] && !pendingCancel(m)))) { draw(); return; }
        if (!member && data.booking.used) { await Sahra.notify(t("bk_used")); draw(); return; }
        var text = m ? t(requestOnly(m) ? "bk_confirm_delete" : "bk_confirm_one", { name: m.guest_name || t("g_no_name"), ref: Sahra.ref(m.id) })
          : t("bk_confirm_all", { members: data.members.map(function (x) { return (x.guest_name || t("g_no_name")) + " · " + Sahra.ref(x.id) + " · " + state(x) + (["pending","approved"].indexOf(x.status)>=0?" · "+t(requestOnly(x)?"bk_delete_request":"bk_cancel_one"):""); }).join("\n") });
        if (!(await Sahra.confirm(text, { danger: true, ok: t(m ? (requestOnly(m)?"bk_delete_request":"bk_cancel_one") : wholeAction(data)) }))) return;
        var payload = ops[key];
        if (!payload) {
          payload = { op: m && pendingCancel(m) || crypto.randomUUID() };
          if (!m) payload.expected = data.members.map(function (x) { return { id: x.id, rev: x.rev }; });
          ops[key] = payload;
        }
        var result = await S.act(path(m ? m.id : row.id, m ? "cancel" : "cancel-booking"), payload);
        // Keep the same operation until confirmed, including transport failure.
        if (result.ok || (result.status >= 400 && result.status < 500)) delete ops[key];
        await read();
        var verified = result.ok && data && !data.booking.unconfirmed && (m ? data.members.some(function (x) { return x.id === m.id && x.status === "cancelled"; })
          : data.booking.active === 0 && data.booking.used === 0);
        var error = result.body && result.body.error;
        await Sahra.notify(verified ? t(m ? (requestOnly(m)?"bk_deleted_verified":"bk_one_verified") : "bk_verified")
          : t(error === "booking_used" ? "bk_used" : error === "booking_changed" ? "bk_changed" : "bk_not_confirmed"));
        if (verified) signal();
      } finally { busy[key] = false; if (root.isConnected) draw(); }
    }
    function draw() {
      if (!data) return;
      Sahra.clear(body);
      var b = data.booking;
      head.querySelector(".bk-summary") ? head.querySelector(".bk-summary").textContent = summary(b)
        : head.appendChild(el("span", { class: "bk-summary", text: summary(b) }));
      body.appendChild(el("p", { class: "muted", text: t("bk_refresh_hint") }));
      if (b.unconfirmed || ops["all:" + bookingId] || data.members.some(function (m) { return ops["one:" + m.id]; })) body.appendChild(el("p", { class: "notice maybe", text: t("bk_not_confirmed") }));
      if ((b.cancelled || b.deleted) && b.active) body.appendChild(el("p", { class: "notice maybe", text: t("bk_partial") }));
      if (!b.active && !b.used) body.appendChild(el("p", { class: "notice", text: t("bk_no_active") }));
      if (b.used) body.appendChild(el("p", { class: "notice maybe", text: t("bk_used") }));
      body.appendChild(el("ul", { class: "bk-members" }, data.members.map(function (m) {
        var item = el("li", { class: "bk-member" },
          el("div", { class: "bk-person" }, el("strong", { text: m.guest_name || t("g_no_name"), attrs: { dir: "auto" } }),
            el("span", { class: "mono muted", text: Sahra.ref(m.id), attrs: { dir: "ltr" } })),
          el("span", { class: "pill " + (m.status === "cancelled" || m.status === "rejected" ? "no" : ""), text: state(m) }));
        if (m.email_sent_at) item.appendChild(el("p", { class: "small muted", text: m.status === "cancelled" ? t(requestOnly(m)?"bk_deleted_email":"bk_sent_cancelled") : t("bk_email_sent", { when: Sahra.when(m.email_sent_at) }) }));
        else if (m.email_status) item.appendChild(el("p", { class: "small muted", text: t("bk_email_pending", { status: SahraText.en["o_st_" + m.email_status] ? t("o_st_" + m.email_status) : t("bk_busy") }) }));
        if (m.cancelled_at) item.appendChild(el("p", { class: "small muted", text: t(requestOnly(m)?"bk_delete_history":"bk_cancel_history", { when: Sahra.when(m.cancelled_at), name: m.cancelled_by || t("bk_unknown_actor") }) }));
        if (m.status === "cancelled" || m.status === "rejected") item.appendChild(el("p", { class: "small muted", text: t("bk_inactive") }));
        if ((["pending", "approved"].indexOf(m.status) >= 0 || ops["one:" + m.id] || pendingCancel(m)) && !m.used_at) item.appendChild(el("button", {
          class: "btn no small-btn", text: t(ops["one:" + m.id] || pendingCancel(m) ? "bk_retry" : requestOnly(m)?"bk_delete_request":"bk_cancel_one"), attrs: { type: "button", disabled: !!busy["one:" + m.id] || !!busy["all:" + bookingId] }, on: { click: function () { cancel(m); } }
        }));
        return item;
      })));
      body.appendChild(el("div", { class: "g-actions" },
        el("button", { class: "btn small-btn", text: t("bk_refresh"), attrs: { type: "button", disabled: loading }, on: { click: read } }),
        Sahra.copyButton(Sahra.ref(b.id), t("bk_copy")),
        el("a",{class:"btn small-btn",text:t("bk_open_guests"),attrs:{href:"/guests.html?status=all&q="+encodeURIComponent(Sahra.ref(b.id))}}),
        el("a",{class:"btn small-btn",text:t("bk_open_requests"),attrs:{href:"/queue.html?status=all&q="+encodeURIComponent(Sahra.ref(b.id))}}),
        (b.total > 1 && b.active || b.unconfirmed || ops["all:" + bookingId]) ? el("button", { class: "btn no small-btn", text: t(ops["all:" + bookingId] || (!b.active && b.unconfirmed) ? "bk_retry" : wholeAction(data)), attrs: { type: "button", disabled: !!b.used || !!busy["all:" + bookingId] }, on: { click: function () { cancel(null); } } }) : null));
    }
    root.cancelOne = function () { root.open = true; cancel({ id: row.id }); };
    root.addEventListener("toggle", function () { if (root.open) read(); });
    return root;
  }
  function params(values) {
    var q = new URLSearchParams();
    Object.keys(values).forEach(function (k) { if (values[k]) q.set(k, values[k]); });
    return q;
  }
  function filters(values, types, apply, withStatus) {
    var choices = [
      ["type", "bf_type", types.map(function (x) { return [x.id, x.name]; })],
      ["delivery", "bf_delivery", [["released",t("bf_released")],["unreleased",t("bf_unreleased")],["emailed",t("bf_emailed")]]],
      ["entry", "bf_entry", [["used",t("bf_used")],["unused",t("bf_unused")]]],
      ["booking", "bf_booking", [["group",t("bf_group")],["single",t("bf_single")],["partial",t("bf_partial")]]],
      ["payment", "bf_payment", [["cash",t("bf_cash")]]]
    ];
    if (withStatus) choices.unshift(["status","bf_status", [["pending",t("q_waiting")],["approved",t("q_approved")],["cancelled",t("q_cancelled_tab")],["rejected",t("q_rejected")]]]);
    var active = choices.filter(function (x) { return values[x[0]] && values[x[0]] !== "all"; });
    var search = S.input("q", "search", { maxlength: 80, value: values.q || "", placeholder: t("bf_search"), autocomplete: "off", enterkeyhint: "search" });
    var bar = el("div", { class: "bk-filterbar" });
    var form = el("form", { class: "bk-search", attrs: { role: "search" } }, search,
      el("button", { class: "btn primary", text: t("g_search"), attrs: { type: "submit" } }));
    form.addEventListener("submit", function (e) { e.preventDefault(); apply(Object.assign({}, values, { q: search.value.trim() })); });
    function sheet() {
      var previous = document.activeElement;
      var fields = choices.map(function (x) { return S.field(t(x[1]), S.select(x[0], [["",t("bf_all")]].concat(x[2]), values[x[0]] === "all" ? "" : values[x[0]])); });
      var f = el("form", { attrs: { method: "dialog" } },
        el("h2", { attrs: { id: "bk-filter-title" }, text: t("bf_filters") }),
        el("div", { class: "bk-filter-fields" }, fields),
        el("p", { class: "small muted", text: t("bf_result_hint") }));
      var dialog = el("dialog", { class: "bk-filter-sheet", attrs: { "aria-labelledby": "bk-filter-title" } }, f);
      function close() { dialog.close(); dialog.remove(); if (previous && previous.isConnected) previous.focus(); }
      f.appendChild(el("div", { class: "bk-filter-actions" },
        el("button", { class: "btn", text: t("bf_close"), attrs: { type: "button" }, on: { click: close } }),
        el("button", { class: "btn primary", text: t("bf_apply"), attrs: { type: "submit" } })));
      f.addEventListener("submit", function (e) {
        e.preventDefault(); var next = Object.assign({}, values, { q: search.value.trim() });
        choices.forEach(function (x) { next[x[0]] = f.elements[x[0]].value; });
        if (withStatus && !next.status) next.status = "all";
        close(); apply(next);
      });
      dialog.addEventListener("cancel", function (e) { e.preventDefault(); close(); });
      document.body.appendChild(dialog); dialog.showModal(); f.querySelector("select").focus();
    }
    bar.append(form, el("div", { class: "g-actions" },
      el("button", { class: "btn", text: t("bf_filters") + (active.length ? " · " + active.length : ""), attrs: { type: "button" }, on: { click: sheet } }),
      el("button", { class: "btn", text: t("bf_reset"), attrs: { type: "button", disabled: !active.length && !values.q }, on: { click: function () { apply(withStatus ? {status:"all"} : {}); } } })));
    if (active.length) bar.appendChild(el("div", { class: "bk-filter-chips" }, active.map(function (x) {
      var option = x[2].find(function (v) { return v[0] === values[x[0]]; });
      return el("span", { class: "pill", text: t(x[1]) + ": " + (option ? option[1] : values[x[0]]) });
    })));
    return bar;
  }
  function pager(count, next, loading, move, top, page, position) {
    page = page || 0;
    var rtl = document.documentElement.dir === "rtl";
    return el("nav", { class: "bk-pager" + (position ? " bk-pager-" + position : ""), attrs: { "aria-label": t(position === "top" ? "bf_pages_top" : position === "bottom" ? "bf_pages_bottom" : "bf_pages"), "aria-busy": loading ? "true" : "false", tabindex:-1 } },
      el("p", { class: "small muted bk-page-count", text: t("bf_page_count", {n:count}), attrs: { role:position === "bottom" ? "note" : "status" } }),
      el("div",{class:"bk-page-arrows"},
        el("button", {class:"btn bk-page-prev",text:rtl?"›":"‹",attrs:{type:"button",disabled:loading||page===0,"aria-label":t("bf_previous")},on:{click:function(){move(-1);}}}),
        el("span",{class:"bk-page-number",text:t("bf_page",{n:page+1}),attrs:{"aria-live":position === "bottom" ? "off" : "polite","aria-current":"page"}}),
        el("button", {class:"btn bk-page-next",text:rtl?"‹":"›",attrs:{type:"button",disabled:loading||!next,"aria-label":t("bf_next")},on:{click:function(){move(1);}}})),
      el("button", {class:"btn bk-page-top",attrs:{type:"button","aria-label":t("bf_top"),title:t("bf_top")},on:{click:top}},S.icon("search")));
  }

  window.SahraBooking = { card: card, guide: guide, filters: filters, params: params, pager: pager };
})();
