// The organiser dashboard's three charts (brainstorm ideas 26 and 27), drawn as
// inline SVG: no chart library. Every number also appears as text (legend or
// tile), so a chart is never the only way to read it.
//   1. Requests per day, the last 14 days, in the party's own time zone (bars).
//   2. Tickets by type: places held (pending + approved) per type (donut).
//   3. Arrivals per 15 minutes, once anyone has been admitted (bars).
"use strict";
var SahraCharts = (function () {
  var t = Sahra.t, el = Sahra.el;
  var NS = "http://www.w3.org/2000/svg";
  var drawn = false;
  // The owner's palette: charcoal and greys only (green, red and amber are kept for meaning).
  var PALETTE = ["#383635", "#8a8786", "#c4c3c2", "#5f5c5b", "#a9a7a6", "#1f1e1d"];

  function svg(tag, attrs, kids) {
    var n = document.createElementNS(NS, tag);
    Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    (kids || []).forEach(function (k) { if (k) n.appendChild(k); });
    return n;
  }
  function label(text, attrs) { var n = svg("text", attrs); n.textContent = text; return n; }
  function tip(text) { var n = svg("title"); n.textContent = text; return n; }

  function dayKey(ms, tz) {
    try { return new Intl.DateTimeFormat("en-CA", { timeZone: tz || undefined, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms); }
    catch (e) { return new Date(ms).toISOString().slice(0, 10); }
  }
  function dayLabel(ms, tz) {
    var loc = Sahra.lang() === "ar" ? "ar-EG-u-nu-latn" : "en-GB";
    // Short numeric dates ("26/9"): month names do not fit under 14 bars, in Arabic least of all.
    try { return new Intl.DateTimeFormat(loc, { timeZone: tz || undefined, day: "numeric", month: "numeric" }).format(ms); }
    catch (e) { return ""; }
  }

  /** Vertical bars: items [{ label, value, tip }]. */
  function bars(items, color) {
    var W = 340, H = 150, top = 16, bottom = 26, gap = 4, pad = 18;
    var max = Math.max(1, Math.max.apply(null, items.map(function (x) { return x.value; })));
    // Bars at most 36 wide, centred: one or two bars do not stretch across the card.
    var bw = Math.min(36, Math.max(2, (W - 2 * pad - gap * (items.length - 1)) / items.length));
    var left = (W - (bw * items.length + gap * (items.length - 1))) / 2;
    var nodes = [];
    items.forEach(function (x, i) {
      var h = Math.round((H - top - bottom) * (x.value / max));
      var bx = left + i * (bw + gap);
      nodes.push(svg("rect", { x: bx, y: H - bottom - h, width: bw, height: Math.max(h, x.value ? 2 : 0), rx: 3, fill: color }, [tip(x.tip)]));
      if (x.value) nodes.push(label(String(x.value), { x: bx + bw / 2, y: H - bottom - h - 4, "text-anchor": "middle", "font-size": 10, fill: "#5f5c5b" }));
      if (x.label) nodes.push(label(x.label, { x: bx + bw / 2, y: H - 8, "text-anchor": "middle", "font-size": 10, fill: "#5f5c5b" }));
    });
    nodes.push(svg("line", { x1: 0, x2: W, y1: H - bottom + 0.5, y2: H - bottom + 0.5, stroke: "#c4c3c2" }));
    return svg("svg", { viewBox: "0 0 " + W + " " + H, role: "img" }, nodes);
  }

  function requestsChart(stats, party) {
    var tz = party && party.time_zone;
    var byDay = {};
    stats.requests_per_hour.forEach(function (h) { var k = dayKey(h.at, tz); byDay[k] = (byDay[k] || 0) + h.requests; });
    var items = [];
    for (var i = 13; i >= 0; i--) {
      var ms = Date.now() - i * 86400000;
      var v = byDay[dayKey(ms, tz)] || 0;
      items.push({ value: v, label: i % 2 === 0 ? dayLabel(ms, tz) : "", tip: dayLabel(ms, tz) + ": " + v });
    }
    return card(t("d_chart_requests"), bars(items, PALETTE[0]));
  }

  function typesChart(stats) {
    var rows = stats.by_type.map(function (r) { return { name: r.name === "No type" ? t("d_no_type") : r.name, value: r.pending + r.approved }; })
      .filter(function (r) { return r.value > 0; });
    if (!rows.length) return null;
    var total = rows.reduce(function (n, r) { return n + r.value; }, 0);
    var R = 60, C = 2 * Math.PI * R, offset = 0;
    var rings = rows.map(function (r, i) {
      var len = C * (r.value / total);
      var ring = svg("circle", { cx: 80, cy: 80, r: R, fill: "none", stroke: PALETTE[i % PALETTE.length], "stroke-width": 26,
        "stroke-dasharray": len + " " + (C - len), "stroke-dashoffset": -offset, transform: "rotate(-90 80 80)" }, [tip(r.name + ": " + r.value)]);
      offset += len;
      return ring;
    });
    var donut = svg("svg", { viewBox: "0 0 160 160", role: "img", class: "donut" },
      rings.concat([label(String(total), { x: 80, y: 86, "text-anchor": "middle", "font-size": 26, "font-weight": 400, "font-family": "Instrument Serif, Amiri, Georgia, serif", fill: "#383635" })]));
    donut.setAttribute("width", "160");
    var legend = el("div", { class: "legend" }, rows.map(function (r, i) {
      var dot = el("span", { class: "dot" });
      dot.style.background = PALETTE[i % PALETTE.length]; // CSSOM: allowed under the page's style policy
      return el("span", null, dot, el("span", { text: r.name + " " + r.value, attrs: { dir: "auto" } }));
    }));
    return card(t("d_chart_types"), el("div", { class: "center" }, donut), legend);
  }

  function arrivalsChart(stats, party) {
    var slots = stats.check_ins_per_15_min;
    if (!slots.length) return null;
    var tz = party && party.time_zone;
    var first = slots[0].at, last = slots[slots.length - 1].at;
    var by = {};
    slots.forEach(function (s) { by[s.at] = s.people; });
    var items = [];
    for (var at = first; at <= last && items.length < 48; at += 900000) {
      var v = by[at] || 0;
      items.push({ value: v, label: items.length % 4 === 0 ? Sahra.time(at, tz) : "", tip: Sahra.time(at, tz) + ": " + v });
    }
    return card(t("d_chart_arrivals"), bars(items, PALETTE[0]));
  }

  function card(title, chart, extra) {
    return el("section", { class: "card chart" }, el("p", { class: "small muted", text: title }), chart, extra || null);
  }

  return {
    draw: function (node, stats, party) {
      Sahra.clear(node);
      // Bars grow in on the first drawing only, not on every refresh.
      node.classList.toggle("animate", !drawn);
      drawn = true;
      [arrivalsChart(stats, party), requestsChart(stats, party), typesChart(stats)].forEach(function (c) { if (c) node.appendChild(c); });
    },
  };
})();
