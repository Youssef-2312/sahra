// Guest ticket page: /ticket.html#t=<signed link>. The link stays in the URL
// fragment (never sent to a server by the browser) and goes to the API in the
// x-sahra-ticket header. Order (owner, brainstorm idea 5): the QR code very large
// on white; name, ticket type, group; party, date, entry time; the address or the
// countdown to it. Fail closed: when the ticket cannot be used (not sent yet,
// pending, rejected, cancelled, on hold, already used) a plain message replaces
// the QR code.
"use strict";
(function () {
  var t = Sahra.t, el = Sahra.el;
  var link = new URLSearchParams(location.hash.slice(1)).get("t") || "";
  var app = document.getElementById("app");
  var data = null;
  var failed = null;
  var timer = null;

  // Same settings as the camera test (docs/qr-camera-test): level M, alphanumeric.
  function qrImage(text) {
    var q = qrcode(0, "M");
    try { q.addData(text, "Alphanumeric"); q.make(); }
    catch (e) { q = qrcode(0, "M"); q.addData(text, "Byte"); q.make(); }
    var n = q.getModuleCount(), quiet = 4, scale = 12, size = (n + quiet * 2) * scale;
    var c = document.createElement("canvas");
    c.width = c.height = size;
    var g = c.getContext("2d");
    g.fillStyle = "#fff";
    g.fillRect(0, 0, size, size);
    g.fillStyle = "#000";
    for (var r = 0; r < n; r++) for (var col = 0; col < n; col++) {
      if (q.isDark(r, col)) g.fillRect((col + quiet) * scale, (r + quiet) * scale, scale, scale);
    }
    return c.toDataURL("image/png");
  }

  function remember() {
    var list = [];
    try { list = JSON.parse(Sahra.store.get("sahra_tickets") || "[]"); } catch (e) { list = []; }
    if (!Array.isArray(list)) list = [];
    var path = "/ticket.html#t=" + link;
    var known = list.filter(function (x) { return x && x.link === path; })[0];
    list = list.filter(function (x) { return x && x.link !== path; });
    list.unshift({ party: data.party.id, link: path, at: known ? known.at : Date.now() });
    Sahra.store.set("sahra_tickets", JSON.stringify(list.slice(0, 20)));
  }

  function statusMessage(k) {
    if (k.used) return ["info", t("st_used")];
    if (k.on_hold) return ["maybe", t("st_on_hold")];
    if (k.status === "pending") return ["info", t("st_pending")];
    if (k.status === "approved") return ["info", t("st_approved")];
    if (k.status === "rejected") return ["no", t("st_rejected")];
    if (k.status === "cancelled") return ["no", t("st_cancelled")];
    return ["maybe", t("error_generic")];
  }

  function addressCard(p) {
    var body;
    if (p.address || p.venue_name) {
      body = [p.venue_name ? el("p", { text: p.venue_name, attrs: { dir: "auto" } }) : null,
        p.address ? el("p", { class: "pre", text: p.address, attrs: { dir: "auto" } }) : null,
        p.map_url ? el("a", { class: "btn", text: t("open_map"), attrs: { href: p.map_url, rel: "noopener", target: "_blank" } }) : null];
    } else if (p.reveal && p.reveal.waiting_for === "time" && p.reveal.at) {
      body = el("p", { text: t("addr_soon_time", { rel: Sahra.rel(p.reveal.at), when: Sahra.when(p.reveal.at, p.time_zone) }) });
    } else if (p.reveal && p.reveal.waiting_for === "owner") {
      body = el("p", { text: t("addr_soon_owner") });
    } else if (p.reveal && p.reveal.mode === "at_time" && p.reveal.at) {
      body = el("p", { text: t("addr_at_time", { rel: Sahra.rel(p.reveal.at) }) });
    } else if (p.reveal && p.reveal.mode === "manual") {
      body = el("p", { text: t("addr_manual") });
    } else {
      body = el("p", { text: t("addr_with_ticket") });
    }
    return el("section", { class: "card" }, el("p", { class: "small muted", text: t("where") }), body);
  }

  function render() {
    Sahra.clear(app);
    if (failed) { app.appendChild(el("p", { class: "notice no", text: failed })); return; }
    if (!data) { app.appendChild(el("p", { class: "muted", text: t("loading") })); return; }
    var k = data.ticket, p = data.party;
    Sahra.title(p.name);
    var usable = !!k.qr && !k.used && !k.on_hold && k.status === "released";

    var side = el("div", { class: "side" }), body = el("div");
    app.appendChild(el("div", { class: "cols" }, side, body));
    if (usable) {
      var src = qrImage(k.qr);
      side.appendChild(el("div", { class: "qr-box" }, el("img", { attrs: { src: src, alt: "QR", width: 300, height: 300 } })));
      side.appendChild(el("p", { class: "center muted", text: t("brightness") }));
    } else {
      var m = statusMessage(k);
      side.appendChild(el("p", { class: "notice " + m[0], text: m[1] }));
      if (k.status === "pending" && p.review_time) side.appendChild(el("p", { class: "small", text: t("review_time_line", { text: p.review_time }), attrs: { dir: "auto" } }));
      if (k.status === "rejected" && k.reject_reason) side.appendChild(el("p", { class: "pre", text: t("reason", { text: k.reject_reason }), attrs: { dir: "auto" } }));
    }

    body.appendChild(el("section", { class: "card" },
      el("ul", { class: "facts" },
        el("li", null, el("span", { class: "small muted", text: t("name_label") }), el("br"), el("strong", { text: k.guest_name || "", attrs: { dir: "auto" } })),
        el("li", null, el("span", { class: "small muted", text: t("ticket_label") }), el("br"),
          el("strong", { text: [k.type, k.people > 1 ? t("group_of", { n: k.people }) : t("one_person")].filter(Boolean).join(" · "), attrs: { dir: "auto" } })),
        k.people > 1 ? el("li", { class: "small", text: t("group_note", { n: k.people }) }) : null,
        k.reference ? el("li", null, el("span", { class: "small muted", text: t("ref_label") }), el("br"), el("strong", { text: k.reference, attrs: { dir: "ltr" } })) : null)));

    var timeLine = p.starts_at ? Sahra.when(p.starts_at, p.time_zone) + (p.ends_at ? " - " + Sahra.time(p.ends_at, p.time_zone) : "") : null;
    body.appendChild(el("section", { class: "card" },
      el("p", { class: "small muted", text: t("when") }),
      el("h2", { text: p.name, attrs: { dir: "auto" } }),
      timeLine ? el("p", { text: timeLine }) : null,
      k.entry_from ? el("p", { class: "pill maybe", text: t("entry_from", { when: Sahra.when(k.entry_from, p.time_zone) }) }) : null));

    body.appendChild(addressCard(p));
    if (p.rules) body.appendChild(el("section", { class: "card" }, el("p", { class: "small muted", text: t("rules") }), el("p", { class: "pre", text: p.rules, attrs: { dir: "auto" } })));
    if (p.cancellation_policy) body.appendChild(el("section", { class: "card" }, el("p", { class: "small muted", text: t("cancel_title") }), el("p", { class: "pre", text: p.cancellation_policy, attrs: { dir: "auto" } })));
    var contact = Sahra.contactCard(p.support);
    if (contact) body.appendChild(contact);

    if (usable) side.appendChild(el("a", { class: "btn wide-btn", text: t("save_qr"), attrs: { href: side.querySelector(".qr-box img").src, download: "sahra-ticket.png" } }));
    body.appendChild(el("button", { class: "btn", text: t("refresh"), attrs: { type: "button" }, on: { click: load } }));
  }

  async function load() {
    if (!link) { failed = t("link_invalid"); render(); return; }
    var r = await Sahra.api.get("/api/guest/ticket", { "x-sahra-ticket": link });
    if (r.status === 404) { failed = t("link_invalid"); data = null; }
    else if (!r.ok) { failed = Sahra.errorText(r); }
    else { failed = null; data = r.body; remember(); }
    render();
    // When the address appears at a set time within the next day, look again just after it.
    if (timer) clearTimeout(timer);
    var at = data && data.party.reveal && data.party.reveal.waiting_for === "time" ? data.party.reveal.at : null;
    if (at && at > Date.now() && at - Date.now() < 86400000) timer = setTimeout(load, at - Date.now() + 3000);
  }

  Sahra.boot({ render: render });
  load();
})();
