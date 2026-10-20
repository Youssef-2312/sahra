// Runs before styles are painted. Appearance preferences contain no account or
// guest data, and storage failures leave the device defaults usable.
"use strict";
var SahraAppearance = (function () {
  var KEY = "sahra_appearance", root = document.documentElement;
  var dark = matchMedia("(prefers-color-scheme: dark)");
  var motion = matchMedia("(prefers-reduced-motion: reduce)");
  var transparency = matchMedia("(prefers-reduced-transparency: reduce)");
  var defaults = { theme: "system", density: "comfortable", motion: "system", transparency: "system" };
  var allowed = { theme: ["system", "light", "dark"], density: ["comfortable", "compact"], motion: ["system", "reduced"], transparency: ["system", "solid"] };
  function validate(value) {
    var out = {};
    Object.keys(defaults).forEach(function (k) { out[k] = value && allowed[k].includes(value[k]) ? value[k] : defaults[k]; });
    return out;
  }
  function read() { try { return validate(JSON.parse(localStorage.getItem(KEY))); } catch (_) { return validate(null); } }
  var prefs = read();
  function reducedMotion() { return prefs.motion === "reduced" || motion.matches; }
  function apply() {
    root.dataset.theme = prefs.theme === "system" ? (dark.matches ? "dark" : "light") : prefs.theme;
    root.dataset.themeChoice = prefs.theme;
    root.dataset.density = prefs.density;
    root.dataset.motion = reducedMotion() ? "reduced" : "system";
    root.dataset.transparency = prefs.transparency === "solid" || transparency.matches ? "solid" : "system";
    document.dispatchEvent(new CustomEvent("sahra:appearance", { detail: get() }));
  }
  function get() { return Object.assign({}, prefs); }
  function set(value) {
    prefs = validate(Object.assign({}, prefs, value));
    try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch (_) {}
    apply();
  }
  function reset() { prefs = validate(null); try { localStorage.removeItem(KEY); } catch (_) {} apply(); }
  [dark, motion, transparency].forEach(function (query) { if (query.addEventListener) query.addEventListener("change", apply); else query.addListener(apply); });
  window.addEventListener("storage", function (e) { if (e.key === KEY || e.key === null) { prefs = read(); apply(); } });
  apply();
  return { get: get, set: set, reset: reset, reducedMotion: reducedMotion };
})();
