// Door scanner: /scan.html (door staff, admins, owners). Rule shown to staff: NO
// GREEN, NO ENTRY. Green only when the server answered "admit"; everything else
// is red (do not admit) or amber (can't verify, paused). Brainstorm idea 7: the
// whole screen turns one colour with one big word, plus a sound and a vibration
// per result.
//
// One scan id per physical scan; it is reused only to retry that same scan
// (network error or "recording"), so a retry can never admit a second time.
// The camera is read with the browser's own QR reader (BarcodeDetector) where it
// exists, otherwise with jsQR (public/vendor/jsqr), loaded only then.
"use strict";
(function () {
  var t = Sahra.t, el = Sahra.el;
  var app = document.getElementById("app");
  var me = null, party = null;
  var state = "idle";              // idle | scanning | checking | verdict
  var video = el("video", { attrs: { playsinline: true, muted: true, autoplay: true } });
  video.muted = true; // iPhones only autoplay a muted inline video
  var stream = null, track = null, detector = null, canvas = null, ctx = null;
  var cameraError = null, torchOn = false;
  var lastText = null, lastAt = 0;
  var shown = null;                // { kind: yes|no|maybe|checking, word, lines[] }
  var nextTimer = null;
  var audio = null;

  // ------------------------------------------------------------ feedback

  function beep(kind) {
    try {
      if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
      var tones = kind === "yes" ? [[880, 0, 0.12], [1320, 0.14, 0.16]] : kind === "no" ? [[220, 0, 0.45]] : [[440, 0, 0.15], [440, 0.25, 0.15]];
      tones.forEach(function (x) {
        var o = audio.createOscillator(), g = audio.createGain();
        o.type = kind === "no" ? "square" : "sine";
        o.frequency.value = x[0];
        g.gain.value = 0.18;
        o.connect(g); g.connect(audio.destination);
        o.start(audio.currentTime + x[1]);
        o.stop(audio.currentTime + x[1] + x[2]);
      });
    } catch (e) { /* no sound on this phone */ }
    try { if (navigator.vibrate) navigator.vibrate(kind === "yes" ? 90 : kind === "no" ? [300, 120, 300] : [150, 100, 150]); } catch (e) { /* none */ }
  }

  // ------------------------------------------------------------ verdicts

  var REASONS = {
    "invalid code": "r_invalid",
    "ticket is for another party": "r_other_party",
    "not approved": "r_not_approved",
    "QR not sent yet": "r_not_released",
    "old QR (ticket was reissued)": "r_old",
    "unknown ticket": "r_unknown",
    "ticket on hold after a database recovery, ask the owner": "r_on_hold",
    "ticket changed, scan again": "r_changed",
    "scan id conflict": "r_conflict",
    "too many scans from this phone, wait a moment": "r_too_many",
  };
  function reasonText(v) {
    if (v.entry_from) return t("sc_too_early", { type: v.type || "", when: Sahra.when(v.entry_from, party && party.time_zone) });
    return REASONS[v.reason] ? t(REASONS[v.reason]) : (v.reason || "");
  }

  function fromServer(v) {
    var tz = party && party.time_zone;
    if (v.verdict === "admit") {
      return { kind: "yes", word: t("sc_admit"), lines: [v.name || "", [v.type, v.people > 1 ? t("sc_people", { n: v.people }) : null].filter(Boolean).join(" · ")] };
    }
    if (v.verdict === "used") {
      var when = v.when ? Sahra.time(v.when, tz) : "";
      return { kind: "no", word: t("sc_used"), lines: [v.by ? t("sc_used_at", { time: when, by: v.by }) : t("sc_used_at_nobody", { time: when }), v.type || ""] };
    }
    if (v.verdict === "stop") return { kind: "no", word: t("sc_stop"), lines: [reasonText(v)] };
    if (v.verdict === "paused") return { kind: "maybe", word: t("sc_paused"), lines: [t("sc_paused_hint")] };
    if (v.verdict === "not_signed_in") return { kind: "maybe", word: t("sc_cant"), lines: [t("sc_signed_out")] };
    // cant_verify, an unknown answer, or retries used up: never green.
    return { kind: "maybe", word: t("sc_cant"), lines: [v.reason ? reasonText(v) : t("sc_cant_hint")] };
  }

  async function check(text) {
    state = "checking";
    shown = { kind: "checking", word: t("sc_checking"), lines: [] };
    render();
    var scanId = crypto.randomUUID();
    var v = null;
    for (var i = 0; i < 6; i++) {
      var r = await Sahra.api.post("/api/scan", { scan_id: scanId, qr: text });
      v = r.status === 200 ? r.body : r.status === 0 ? { verdict: "network" } : { verdict: "cant_verify" };
      if (v.verdict !== "recording" && v.verdict !== "network") break;
      shown = { kind: "checking", word: t("sc_recording"), lines: [] };
      render();
      await new Promise(function (ok) { setTimeout(ok, 800); });
    }
    if (!v || v.verdict === "recording" || v.verdict === "network") v = { verdict: "cant_verify" };
    shown = fromServer(v);
    state = "verdict";
    beep(shown.kind);
    render();
    // Green goes back to the camera by itself after a moment; red and amber wait for "Next guest".
    if (shown.kind === "yes") nextTimer = setTimeout(next, 2500);
  }

  function next() {
    if (nextTimer) { clearTimeout(nextTimer); nextTimer = null; }
    shown = null;
    lastAt = Date.now();
    state = stream ? "scanning" : "idle";
    render();
  }

  // ------------------------------------------------------------ camera

  async function startCamera() {
    cameraError = null;
    try {
      if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === "suspended") audio.resume();
    } catch (e) { /* sound optional */ }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
    } catch (e) {
      cameraError = e && e.name === "NotFoundError" ? t("sc_no_camera") : t("sc_denied");
      render();
      return;
    }
    track = stream.getVideoTracks()[0];
    video.srcObject = stream;
    await video.play().catch(function () {});
    if ("BarcodeDetector" in window) {
      try {
        var formats = await window.BarcodeDetector.getSupportedFormats();
        if (formats.indexOf("qr_code") >= 0) detector = new window.BarcodeDetector({ formats: ["qr_code"] });
      } catch (e) { detector = null; }
    }
    if (!detector && !window.jsQR) await loadScript("/vendor/jsqr/jsQR.js");
    state = "scanning";
    render();
    loop();
  }

  function loadScript(src) {
    return new Promise(function (ok) {
      var s = document.createElement("script");
      s.src = src;
      s.onload = ok;
      s.onerror = ok;
      document.head.appendChild(s);
    });
  }

  async function readFrame() {
    if (!video.videoWidth) return null;
    if (detector) {
      var codes = await detector.detect(video);
      return codes.length ? codes[0].rawValue : null;
    }
    if (!window.jsQR) return null;
    var w = Math.min(640, video.videoWidth), h = Math.round(video.videoHeight * (w / video.videoWidth));
    if (!canvas) { canvas = document.createElement("canvas"); ctx = canvas.getContext("2d", { willReadFrequently: true }); }
    canvas.width = w; canvas.height = h;
    ctx.drawImage(video, 0, 0, w, h);
    var img = ctx.getImageData(0, 0, w, h);
    var code = window.jsQR(img.data, w, h, { inversionAttempts: "dontInvert" });
    return code ? code.data : null;
  }

  async function loop() {
    if (!stream) return;
    if (state === "scanning") {
      var text = null;
      try { text = await readFrame(); } catch (e) { text = null; }
      // The same code still in front of the camera just after its result is not a new scan.
      if (text && !(text === lastText && Date.now() - lastAt < 4000) && state === "scanning") {
        lastText = text;
        check(text.trim());
      }
    }
    setTimeout(loop, 150);
  }

  async function toggleLight() {
    if (!track) return;
    torchOn = !torchOn;
    try { await track.applyConstraints({ advanced: [{ torch: torchOn }] }); } catch (e) { torchOn = false; }
    render();
  }
  function hasTorch() {
    try { return !!(track && track.getCapabilities && track.getCapabilities().torch); } catch (e) { return false; }
  }

  window.addEventListener("pagehide", function () { if (stream) stream.getTracks().forEach(function (x) { x.stop(); }); });

  // ------------------------------------------------------------ render

  function render() {
    Sahra.clear(app);
    if (!me) {
      app.appendChild(el("p", { class: "notice maybe", text: t("sc_signed_out") }));
      return;
    }
    // Everything inside one centred column (bigger on a desktop); Back leaves the scanner.
    var wrap = el("div", { class: "scan-wrap" });
    app.appendChild(wrap);
    var app0 = app;
    app = wrap;
    app.appendChild(el("a", { class: "btn link", text: (Sahra.lang() === "ar" ? "\u2192 " : "\u2190 ") + t("back"), attrs: { href: me.staff.role === "door" ? "/" : "/dashboard.html" } }));
    app.appendChild(el("div", { class: "row" },
      el("strong", { text: party ? party.name : me.party.name, attrs: { dir: "auto" } }),
      el("span", { class: "pill", text: t("sc_rule") })));
    var finder = el("div", { class: "viewfinder" }, video, el("div", { class: "frame" }));
    finder.hidden = !stream;
    app.appendChild(finder);
    if (stream) video.play().catch(function () {});
    if (!stream) {
      app.appendChild(el("p", { class: "muted", text: t("sc_point") }));
      if (cameraError) app.appendChild(el("p", { class: "notice no", text: cameraError }));
      app.appendChild(el("button", { class: "btn primary", text: t("sc_start"), attrs: { type: "button" }, on: { click: startCamera } }));
    } else {
      app.appendChild(el("p", { class: "center muted", text: t("sc_point") }));
      if (hasTorch()) app.appendChild(el("button", { class: "btn" + (torchOn ? " primary" : ""), text: t("sc_light"), attrs: { type: "button", "aria-pressed": String(torchOn) }, on: { click: toggleLight } }));
    }
    // The organiser's number, so door staff can call during a problem (brainstorm idea 16).
    var sup = party && (party.support ? party.support.phone : party.support_phone);
    if (sup) app.appendChild(el("p", { class: "small muted center sc-contact" }, t("sc_organiser") + " ",
      el("a", { text: sup, attrs: { href: "tel:" + sup.replace(/[^0-9+]/g, ""), dir: "ltr" } })));
    if (shown) {
      var screen = el("div", { class: "verdict full " + shown.kind, attrs: { role: "alert" } },
        el("div", { class: "word", text: shown.word }),
        el("div", { class: "lines" }, shown.lines.filter(Boolean).map(function (l) { return el("p", { text: l, attrs: { dir: "auto" } }); })));
      if (state === "verdict") screen.appendChild(el("button", { class: "btn", text: t("sc_next"), attrs: { type: "button" }, on: { click: next } }));
      app.appendChild(screen);
    }
    app = app0;
  }

  (async function () {
    me = await Sahra.api.me();
    if (me) {
      var p = await Sahra.api.get("/api/party");
      if (p.ok) party = p.body;
    }
    Sahra.boot({ render: render, me: me, footer: false });
  })();
})();
