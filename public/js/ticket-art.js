// About's single ticket follows scroll and pointer movement with a soft, settling pose.
// No animation loop runs when the ticket is offscreen, still, or reduced motion is set.
"use strict";
(function () {
  if (!window.IntersectionObserver || !window.matchMedia) return;
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
  var fine = window.matchMedia("(hover: hover) and (pointer: fine)");
  var states = Array.from(document.querySelectorAll("[data-ticket-motion]")).map(function (stage) {
    return { stage: stage, img: stage.querySelector("img"), active: false, px: 0, py: 0, pose: [0, 0, 0, 0], frame: 0 };
  });
  function clamp(n) { return Math.max(-1, Math.min(1, n)); }
  function wake(s) {
    if (s.frame || !s.active || reduce.matches) return;
    s.frame = requestAnimationFrame(function tick() {
      s.frame = 0;
      if (!s.active || reduce.matches) return;
      var r = s.stage.getBoundingClientRect();
      var progress = clamp((innerHeight / 2 - (r.top + r.height / 2)) / ((innerHeight + r.height) / 2));
      var target = [-progress * 22, -progress * 4 - s.py * 3, s.px * 5, progress * 3 + s.px];
      var moving = false;
      s.pose = s.pose.map(function (value, i) {
        var delta = target[i] - value;
        if (Math.abs(delta) > .015) moving = true;
        return Math.abs(delta) < .015 ? target[i] : value + delta * .12;
      });
      s.img.style.transform = "translateY(" + s.pose[0].toFixed(3) + "px) rotateX(" + s.pose[1].toFixed(3) + "deg) rotateY(" + s.pose[2].toFixed(3) + "deg) rotateZ(" + s.pose[3].toFixed(3) + "deg) scale(.97)";
      if (moving) s.frame = requestAnimationFrame(tick);
    });
  }
  var observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      var s = states.find(function (x) { return x.stage === entry.target; });
      s.active = entry.isIntersecting;
      if (s.active) wake(s); else { cancelAnimationFrame(s.frame); s.frame = 0; }
    });
  }, { threshold: .05 });
  states.forEach(function (s) {
    observer.observe(s.stage);
    var pointerTarget = s.stage.closest(".ab-hero") || s.stage;
    pointerTarget.addEventListener("pointermove", function (e) {
      if (!fine.matches || e.pointerType !== "mouse") return;
      var r = s.stage.getBoundingClientRect();
      s.px = clamp((e.clientX - r.left) / r.width * 2 - 1);
      s.py = clamp((e.clientY - r.top) / r.height * 2 - 1); wake(s);
    });
    pointerTarget.addEventListener("pointerleave", function () { s.px = s.py = 0; wake(s); });
  });
  window.addEventListener("scroll", function () { states.forEach(wake); }, { passive: true });
  window.addEventListener("resize", function () { states.forEach(wake); }, { passive: true });
  reduce.addEventListener("change", function () {
    states.forEach(function (s) { cancelAnimationFrame(s.frame); s.frame = 0; s.pose = [0, 0, 0, 0]; s.img.style.transform = ""; wake(s); });
  });
})();
