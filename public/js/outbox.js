// Emails: /outbox.html (owner and admin). Every email Sahra sends for the party
// waits here first. Messages to guests and change notices need approval; ticket
// emails go out on their own. Sending is the server's job (every few minutes);
// this page approves, cancels and shows what happened.
"use strict";
(function () {
  var t = Sahra.t, el = Sahra.el, S = SahraStaff;
  var TABS = [["awaiting_approval", "o_tab_awaiting"], ["queued", "o_tab_queued"], ["sent", "o_tab_sent"], ["failed", "o_tab_failed"], ["cancelled", "o_tab_cancelled"], ["", "o_tab_all"]];
  // Rows the server can approve or cancel one by one (src/routes/outbox.ts isOutboxId): ticket
  // emails sent on their own (other ids) are only shown.
  var PICK = /^(?:(?:announce|notice):)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?::[0-9A-HJKMNP-TV-Z]{16})?$/;
  var dates = {}, loadSeq = 0, loading = false;
  var initialDates = new URLSearchParams(location.search);
  ["date_from","date_to"].forEach(function(k){if(initialDates.has(k))dates[k]=initialDates.get(k);});
  var tab = null, rows = null, next = null, failed = null, awaiting = null, note = null, busy = false, sending = false;

  function pill(status) {
    var cls = status === "sent" ? "yes" : status === "failed" || status === "cancelled" ? "no" : "maybe";
    return el("span", { class: "pill " + cls, text: t("o_st_" + status) });
  }

  async function load(more) {
    var seq = ++loadSeq;
    loading = true;
    var q = SahraBooking.params(dates);
    if (tab) q.set("status", tab);
    if (more && next) q.set("before", next);
    S.redraw();
    var r = await Sahra.api.get("/api/outbox?" + q.toString());
    if (seq !== loadSeq) return;
    loading = false;
    if (!r.ok) { failed = r; S.redraw(); return; }
    failed = null;
    rows = more && rows ? rows.concat(r.body.rows) : r.body.rows;
    next = r.body.next;
    S.redraw();
  }
  async function count() {
    var r = await Sahra.api.get("/api/outbox?status=awaiting_approval");
    awaiting = r.ok ? { n: r.body.rows.length, more: !!r.body.next } : null;
  }

  async function change(which, body, confirmText) {
    if (busy || (confirmText && !(await Sahra.confirm(confirmText)))) return;
    busy = true;
    S.redraw();
    var r = await S.act("/api/outbox/" + which, body);
    busy = false;
    if (!r.ok) note = ["no", S.why(r)];
    else {
      var n = which === "approve" ? r.body.approved : r.body.cancelled;
      note = n ? ["yes", S.tn(which === "approve" ? "o_approved_n" : "o_cancelled_n", n)] : ["maybe", t("o_nothing_changed")];
    }
    await count();
    await load(false);
  }

  function rowCard(x) {
    var canPick = PICK.test(x.id);
    var acts = [];
    if (canPick && x.status === "awaiting_approval") acts.push(el("button", { class: "btn primary small-btn", text: t("o_approve"), attrs: { type: "button", disabled: busy }, on: { click: function () { change("approve", { ids: [x.id] }); } } }));
    if (canPick && (x.status === "awaiting_approval" || x.status === "queued")) acts.push(el("button", { class: "btn no small-btn", text: t("o_cancel"), attrs: { type: "button", disabled: busy }, on: { click: function () { change("cancel", { ids: [x.id] }, t("o_cancel_one_confirm")); } } }));
    var when = x.status === "sent" && x.sent_at ? t("o_sent_at", { when: Sahra.when(x.sent_at) })
      : x.status === "cancelled" && x.cancelled_at ? t("o_cancelled_at", { when: Sahra.when(x.cancelled_at) })
        : t("o_created_at", { when: Sahra.when(x.created_at) });
    var erased = !x.to_email && !x.body_text;
    return el("li", { class: "o-row" },
      el("div", { class: "o-top" },
        el("div", { class: "o-text" }, el("strong", { text: erased ? t("o_erased") : x.subject || t("o_no_subject"), attrs: { dir: "auto" } }),
          el("span", { class: "muted small", text: [x.to_email, when].filter(Boolean).join(" · "), attrs: { dir: "auto" } })),
        pill(x.status)),
      x.status === "failed" || (x.last_error && x.status !== "sent") ? el("p", { class: "o-error small", text: t("o_error", { n: x.attempts || 0, error: x.last_error || "" }) }) : null,
      x.body_text ? el("details", { class: "o-body" }, el("summary", { text: t("o_show_text") }), el("pre", { class: "pre", text: x.body_text, attrs: { dir: "auto" } })) : null,
      acts.length ? el("div", { class: "g-actions" }, acts) : null);
  }

  var find = "";
  function fillList(list) {
    Sahra.clear(list);
    var shown = rows.filter(function (x) { return Sahra.matches(find, [x.to_email, x.subject, x.body_text, t("o_st_" + x.status)]); });
    if (find.trim()) list.appendChild(el("p", { class: "small muted find-count", attrs: { role: "status" },
      text: t("q_find_count", { n: shown.length, total: rows.length }) + (next ? " " + t("o_find_more") : "") }));
    if (!shown.length) { list.appendChild(el("p", { class: "s-empty muted", text: t("q_find_none") })); return; }
    list.appendChild(el("ul", { class: "o-list" }, shown.map(rowCard)));
  }

  async function sendNow(button){if(sending)return;sending=true;button.disabled=true;button.textContent=t("o_sending_now");
    var r=await Sahra.api.post("/api/outbox/send-now",{});sending=false;
    if(!r.ok){note=["no",S.why(r)];}else{var b=r.body;note=["yes",t("o_send_now_result",{sent:b.sent||0,failed:b.failed||0,retry:b.retry||0,skipped:b.skipped?t("o_send_skip_"+b.skipped):""})];}
    await count();await load(false);
  }
  function render(me, app) {
    if (tab === null) { app.appendChild(el("p", { class: "muted", text: t("loading") })); return; }
    if (awaiting && awaiting.n > 0) {
      var label = awaiting.more ? t("o_waiting_more", { n: awaiting.n }) : S.tn("o_waiting_n", awaiting.n);
      app.appendChild(el("div", { class: "notice maybe o-banner" },
        el("div", null, el("strong", { text: label }), el("p", { class: "small", text: t("o_waiting_p") + (dates.date_from || dates.date_to ? " " + t("bf_bulk_all_dates") : "") })),
        el("div", { class: "g-actions" },
          el("button", { class: "btn primary small-btn", text: t("o_approve_all"), attrs: { type: "button", disabled: busy }, on: { click: function () { change("approve", { all_awaiting: true }, t("o_approve_all_confirm") + (dates.date_from || dates.date_to ? "\n\n" + t("bf_bulk_all_dates") : "")); } } }),
          el("button", { class: "btn no small-btn", text: t("o_cancel_all"), attrs: { type: "button", disabled: busy }, on: { click: function () { change("cancel", { all_awaiting: true }, t("o_cancel_all_confirm") + (dates.date_from || dates.date_to ? "\n\n" + t("bf_bulk_all_dates") : "")); } } }))));
    }
    if (note) {
      var box = S.sayBox();
      S.say(box, note[0], note[1]);
      app.appendChild(box);
    }
    var list = el("div"), search=S.input("email_search","search",{value:find,placeholder:t("o_find_ph"),"aria-label":t("o_find_ph"),maxlength:200});
    var form=el("form",{class:"bk-search",attrs:{role:"search"}},search,el("button",{class:"btn primary",text:t("g_search"),attrs:{type:"submit"}}));
    function filterRows(){find=search.value;if(rows)fillList(list);}
    search.addEventListener("input",filterRows);form.addEventListener("submit",function(e){e.preventDefault();filterRows();});
    var toolbar=el("div",{class:"bk-filterbar o-filterbar"},S.viewPicker("email-view",TABS.map(function(x){return [x[0],t(x[1])];}),tab,function(value){tab=value;rows=null;note=null;S.redraw();load(false);}),form,
      el("div",{class:"g-actions"},el("button",{class:"btn bk-date-shortcut",text:t("bf_dates"),attrs:{type:"button"},on:{click:function(){
        var dialog,control=SahraBooking.dates(dates,function(v){dialog.close();dates=v;rows=null;next=null;failed=null;S.redraw();load(false);});control.open=true;
        dialog=S.openPanel(t("bf_dates"),control);dialog.querySelector('input').focus();
      }}})));
    var range=[dates.date_from,dates.date_to].filter(Boolean).join(" / ");
    if(range)toolbar.appendChild(el("div",{class:"bk-filter-chips"},el("span",{class:"pill",text:t("bf_dates")+": "+range,attrs:{dir:"auto"}})));
    app.appendChild(toolbar);
    if (failed) { app.appendChild(el("p", { class: "notice no", text: S.why(failed) })); return; }
    if (rows === null) { app.appendChild(el("p", { class: "muted", text: t("loading") })); return; }
    if (!rows.length) { app.appendChild(el("p", { class: "s-empty muted", text: t("o_none_" + (tab || "all")) })); return; }
    // Filter by recipient, subject or text; redraws only the list, so typing keeps its place.
    app.appendChild(list);
    fillList(list);
    if (next) app.appendChild(el("button", { class: "btn small-btn", text: t("o_older"), attrs: { type: "button",disabled:loading }, on: { click: function () { if(!loading)load(true); } } }));
  }

  var first = true;
  SahraStaff.start({
    page: "outbox", title: "o_title", lede: "o_lede",
    actions:function(){return el("button",{class:"btn primary",text:t("o_send_now"),attrs:{type:"button",disabled:sending},on:{click:function(e){sendNow(e.currentTarget);}}});},
    render: function (me, app) {
      render(me, app);
      if (!first) return;
      first = false;
      count().then(function () {
        tab = awaiting && awaiting.n ? "awaiting_approval" : "";
        load(false);
      });
    },
  });
})();
