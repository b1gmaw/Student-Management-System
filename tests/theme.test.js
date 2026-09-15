// Dark mode is not a separate palette — it is light mode at the dark end of the
// same scale. This suite recomputes that claim from the source.
//
// The drift it exists to catch, measured before the rework:
//   - --container-bg was #1a1d2e, chroma 0.078, where light's card is pure white at
//     0.000. Every dark surface carried a navy-purple cast light mode never had.
//   - --border-color sat 2.08x above its container against light's 1.23x, so every
//     table and panel edge shouted where light mode whispers.
//   - --success-color was 2.74x brighter relative to its surface than light's is.
//
// None of that shows up in a diff, and none of it is visible to someone reading the
// hex values. It only shows up as ratios, which is what this file computes.

const fs = require('fs');
const path = require('path');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'Index.html'), 'utf8');

let pass = 0, fail = 0;
function check(n, c, d) {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + "\n        " + d); }
}

// ---- colour maths (WCAG 2.1 relative luminance) ----------------------------
function rgb(h) {
  h = h.replace('#', '');
  if (h.length === 3) h = h.split('').map(function (c) { return c + c; }).join('');
  return [0, 2, 4].map(function (i) { return parseInt(h.substr(i, 2), 16); });
}
function lum(hex) {
  const c = rgb(hex).map(function (v) {
    v = v / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function ratio(a, b) {
  const la = lum(a), lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
// How far a colour sits from grey, in absolute terms.
//
// ⚠️ NOT HSL saturation, which is lightness-dependent and useless for this: #f7f8fc
// reports 0.45 saturation while being visually almost white, and the old navy
// #1a1d2e reported 0.28 — barely different from its replacement. Chroma separates
// them properly (border-color went 0.200 -> 0.082 against light's 0.055).
function chroma(hex) {
  const c = rgb(hex);
  return (Math.max.apply(null, c) - Math.min.apply(null, c)) / 255;
}

// ---- parse both token blocks out of the stylesheet -------------------------
function tokens(selector) {
  const at = HTML.indexOf(selector);
  if (at === -1) return {};
  const block = HTML.slice(at, HTML.indexOf('}', at));
  const out = {};
  const re = /(--[a-z-]+)\s*:\s*([^;]+);/g;
  let m;
  while ((m = re.exec(block)) !== null) out[m[1]] = m[2].trim();
  return out;
}
const LIGHT = tokens('\n      :root {');
const DARK  = tokens('\n      body.dark-mode {');

console.log("\n1. the two themes define the same tokens");
{
  check("light palette parsed", Object.keys(LIGHT).length >= 20,
    "found " + Object.keys(LIGHT).length + " — the :root block moved or changed shape");
  check("dark palette parsed", Object.keys(DARK).length >= 20,
    "found " + Object.keys(DARK).length + " — the body.dark-mode block moved");

  // ⚠️ A token added to one theme and forgotten in the other is the classic failure
  // here: it silently inherits the other theme's value and looks fine to whoever
  // added it, because they only tested the theme they were working in.
  const missingDark = Object.keys(LIGHT).filter(function (k) { return !(k in DARK); });
  const missingLight = Object.keys(DARK).filter(function (k) { return !(k in LIGHT); });
  check("every light token has a dark counterpart", missingDark.length === 0,
    "dark mode inherits the light value for: " + missingDark.join(", "));
  check("every dark token has a light counterpart", missingLight.length === 0,
    "orphaned in dark: " + missingLight.join(", "));
}

console.log("\n2. dark reproduces light's relationships, it does not invent new ones");
{
  // Each pair: how far does the first sit from the second? Dark should land within
  // 0.75-1.35x of light's answer. Outside that the two themes are different designs.
  const PAIRS = [
    ["--border-color",       "--container-bg",   "panel and table edges"],
    ["--report-header-bg",   "--container-bg",   "report header tint"],
    ["--table-header-bg",    "--container-bg",   "table header tint"],
    ["--row-hover",          "--container-bg",   "row hover"],
    ["--bg-color",           "--container-bg",   "page behind the card"],
    ["--total-row-bg",       "--container-bg",   "合計 row"],
    ["--input-border",       "--input-bg",       "input affordance"],
    ["--text-color",         "--container-bg",   "body text"],
    ["--text-muted",         "--container-bg",   "muted text"],
    ["--table-header-text",  "--table-header-bg","table header label"],
    ["--report-header-text", "--report-header-bg","report header label"],
    ["--alert-danger-text",  "--alert-danger-bg","danger text"],
    ["--alert-warning-text", "--alert-warning-bg","warning text"],
    ["--primary-color",      "--container-bg",   "primary accent"],
    ["--success-color",      "--container-bg",   "success accent"]
    // ⚠️ --edit-color is deliberately NOT in this list. Light's #d69e2e sits at only
    // 2.39x against white — reproducing that faithfully on dark would mean a colour
    // nobody can read. The dark value is 3.51x, better than light rather than equal
    // to it, and is checked for AA-large in section 5 instead.
  ];
  PAIRS.forEach(function (p) {
    const a = p[0], b = p[1], what = p[2];
    if (!LIGHT[a] || !LIGHT[b] || !DARK[a] || !DARK[b]) return;
    const rl = ratio(LIGHT[a], LIGHT[b]);
    const rd = ratio(DARK[a], DARK[b]);
    const drift = rd / rl;
    check(what + " keeps its light-mode weight",
      drift >= 0.75 && drift <= 1.35,
      a + " vs " + b + ": light " + rl.toFixed(2) + "x, dark " + rd.toFixed(2) +
      "x — drift " + drift.toFixed(2) + "x, outside 0.75-1.35x");
  });
}

console.log("\n3. dark surfaces are neutral, the way light's are");
{
  // ⚠️ THE check that would have caught the navy drift. Contrast ratios said the old
  // palette was fine; chroma is what said it was a different palette.
  const SURFACES = ["--bg-color", "--container-bg", "--table-header-bg", "--row-hover",
                    "--border-color", "--input-bg"];
  SURFACES.forEach(function (k) {
    if (!LIGHT[k] || !DARK[k]) return;
    const d = Math.abs(chroma(DARK[k]) - chroma(LIGHT[k]));
    check(k + " stays as neutral as its light counterpart", d <= 0.07,
      "chroma " + chroma(LIGHT[k]).toFixed(3) + " -> " + chroma(DARK[k]).toFixed(3) +
      " (delta " + d.toFixed(3) + ") — a tinted surface is a different palette, " +
      "not the same one darkened. The navy this replaced ran to 0.145 on --border-color.");
  });
}

console.log("\n4. every dark foreground is lighter than what it sits on");
{
  // ⚠️ On white a light token is DARKER than its surface; on dark it must be LIGHTER.
  // Matching a contrast ratio without this constraint finds the dark branch and
  // produces a colour that technically passes and is invisible in practice.
  const FG = [
    ["--text-color", "--container-bg"], ["--text-muted", "--container-bg"],
    ["--table-header-text", "--table-header-bg"],
    ["--report-header-text", "--report-header-bg"],
    ["--alert-danger-text", "--alert-danger-bg"],
    ["--alert-warning-text", "--alert-warning-bg"],
    ["--primary-color", "--container-bg"], ["--success-color", "--container-bg"],
    ["--edit-color", "--container-bg"], ["--border-thick", "--container-bg"]
  ];
  FG.forEach(function (p) {
    if (!DARK[p[0]] || !DARK[p[1]]) return;
    check(p[0] + " is lighter than " + p[1], lum(DARK[p[0]]) > lum(DARK[p[1]]),
      "darker than its own surface — it will read as invisible");
  });
}

console.log("\n5. text stays legible in both themes");
{
  check("light body text clears AA", ratio(LIGHT["--text-color"], LIGHT["--container-bg"]) >= 4.5, "");
  check("dark body text clears AA", ratio(DARK["--text-color"], DARK["--container-bg"]) >= 4.5, "");
  // ⚠️ Light's --text-muted is 4.02x against white — already under AA, and predates
  // this work. Light mode is not being touched, so the floor here is AA-large; the
  // shortfall is recorded rather than silently asserted away.
  check("light muted text clears AA-large", ratio(LIGHT["--text-muted"], LIGHT["--container-bg"]) >= 3.0,
    "pre-existing: #718096 on white is 4.02x, under AA's 4.5x");
  check("dark muted text is no worse than light's", 
    ratio(DARK["--text-muted"], DARK["--container-bg"]) >= ratio(LIGHT["--text-muted"], LIGHT["--container-bg"]),
    "the rework must not inherit light's shortfall and deepen it");

  check("dark edit accent clears AA-large",
    ratio(DARK["--edit-color"], DARK["--container-bg"]) >= 3.0,
    "exempt from the drift band because light's own 2.39x is not worth reproducing");

  // ⚠️ These three are used BOTH as text and as button backgrounds carrying white
  // labels. Tuning either role alone breaks the other: the text-optimal indigo
  // (#8b95e4) drops white-on-button to 2.98x, worse than light mode's 4.81x.
  ["--primary-color", "--success-color", "--edit-color"].forEach(function (k) {
    check("white button labels stay readable on " + k,
      ratio("#ffffff", DARK[k]) >= 3.0,
      "white on " + DARK[k] + " is " + ratio("#ffffff", DARK[k]).toFixed(2) +
      "x — this token is a button background as well as a text colour");
  });
}

console.log("\n6. the status overrides follow the same rules");
{
  // These 11 rules used to be a separate ad-hoc Material palette bolted onto the
  // theme. They are now derived from their own light rules like everything else.
  const STATES = [
    ["空き / available",   "#193a1b", "#2fa435"],
    ["使用中 / occupied",  "#55242b", "#d97a7a"],
    ["予約済み / booked",  "#1e3647", "#a1bce4"],
    ["キャンセル依頼",      "#352e17", "#b46234"],
    ["書類 chip",          "#352e17", "#a87f31"]
  ];
  const card = DARK["--container-bg"];
  STATES.forEach(function (s) {
    const name = s[0], bg = s[1], tx = s[2];
    check(name + " tint is present", HTML.indexOf(bg) !== -1, "renamed or removed");
    check(name + " label is lighter than its tint", lum(tx) > lum(bg), "");
    check(name + " label clears AA-large on its tint", ratio(tx, bg) >= 3.0,
      "contrast " + ratio(tx, bg).toFixed(2) + "x");
    // A tint that jumps off the card reads as a block of colour rather than a state.
    check(name + " tint sits close to the card", ratio(bg, card) <= 1.6,
      "tint is " + ratio(bg, card).toFixed(2) + "x off --container-bg");
  });
}

console.log("\n" + (fail === 0 ? "ALL " + pass + " CHECKS PASSED" : pass + " passed, " + fail + " FAILED"));
process.exitCode = fail === 0 ? 0 : 1;
