// Esc closes the top-most dismissible thing.
//
// ⚠️ WHY THIS EXISTS. The handler was written, shipped, and never worked once. Its
// visibility filter read:
//
//     return d !== 'none' && m.offsetParent !== null;
//
// and offsetParent is ALWAYS null for a position:fixed element — which every
// .modal-overlay is. Measured in the browser with 増減推移 open: 26 overlays, 1 visible
// by display, 0 passing the filter. Dispatching a real Escape left it at display:flex.
//
// ⚠️ THE LESSON, and the reason this file leads with a transcription rather than a
// regex: a predicate that is always FALSE does not throw. It makes a feature quietly
// not exist, and reads as correct to anyone skimming it. The same shape as `profileApp`
// reporting a healthy "343 ms / 2 bytes" while measuring nothing at all.

const fs = require('fs');
const path = require('path');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'Index.html'), 'utf8');

let pass = 0, fail = 0;
function check(n, c, d) {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + "\n        " + (d || "")); }
}
const BLOCK = (HTML.match(/<script>[\s\S]*?<\/script>/g) || [])[1] || '';
const HANDLER = BLOCK.slice(BLOCK.indexOf('--- GLOBAL KEYBOARD SHORTCUTS ---'),
                            BLOCK.indexOf('--- NOTIFICATIONS'));
const CODE = HANDLER.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

console.log("\n1. ⚠️ the visibility predicate works for position:fixed");
{
  // Transcribed from _escVisible. `rects` stands in for getClientRects().length.
  function escVisible(el) { return el.display !== 'none' && el.rects > 0; }
  // …and the predicate it replaced, kept so the difference is exercised, not asserted
  // from memory.
  function old(el) { return el.display !== 'none' && el.offsetParent !== null; }

  // ⚠️ THE case. Every modal in this app is position:fixed, so offsetParent is null.
  const openModal = { display: 'flex', offsetParent: null, rects: 1 };
  check("⚠️ an open FIXED modal passes", escVisible(openModal) === true,
    "this single case is the entire bug — 0 of 26 overlays passed before");
  check("...and the predicate it replaced rejected exactly that", old(openModal) === false,
    "if this passes, the old filter was not the cause and the fix is aimed wrong");

  check("a hidden modal does not pass",
    escVisible({ display: 'none', offsetParent: null, rects: 0 }) === false, "");
  check("...nor one inside a hidden ancestor",
    escVisible({ display: 'flex', offsetParent: null, rects: 0 }) === false,
    "display alone would call this visible; getClientRects is what catches it");

  check("⚠️ offsetParent appears nowhere in the handler",
    CODE.indexOf('offsetParent') === -1,
    "it reads as correct and is always null here — never bring it back");
  check("...and the source uses getClientRects",
    /getClientRects\(\)\.length > 0/.test(CODE), "");
}

console.log("\n2. top-most is by z-index, then document order");
{
  // Transcribed from closeTopModal's selection loop.
  function top(list) {
    let t = list[0], tz = -1;
    list.forEach(function (m) {
      let z = parseInt(m.z, 10); if (isNaN(z)) z = 0;
      if (z >= tz) { tz = z; t = m; }
    });
    return t.id;
  }
  // ⚠️ recUnsavedModal is z-index 10050 and its own markup comment says another modal
  // may be open beneath it — so "last in the DOM" picks the wrong one.
  check("⚠️ a higher z-index wins over document order",
    top([{ id: 'unsaved', z: '10050' }, { id: 'other', z: '10000' }]) === 'unsaved',
    "the unsaved prompt sits ABOVE the modal that raised it");
  check("...and on a tie the later element wins",
    top([{ id: 'a', z: '10000' }, { id: 'b', z: '10000' }]) === 'b', "");
  check("...and a missing z-index counts as 0, never NaN",
    top([{ id: 'a', z: 'auto' }, { id: 'b', z: '5' }]) === 'b',
    "NaN comparisons are false, so an unstyled overlay would win every time");
  check("the source reads z-index and guards NaN",
    /zIndex/.test(CODE) && /isNaN\(z\)/.test(CODE), "");
}

console.log("\n3. ⚠️ the closer map is complete — the fallback is not harmless");
{
  // Derived FROM THE SOURCE: every function named close*/hide* that hides a
  // .modal-overlay must be wired into the map. A modal added later with its own closer
  // then fails here rather than silently getting `display = 'none'`, which would skip
  // whatever the closer does.
  const ids = new Set(
    (HTML.match(/<div[^>]*id="([^"]+)"[^>]*class="modal-overlay"/g) || [])
      .map(function (t) { return t.match(/id="([^"]+)"/)[1] })
      .concat((HTML.match(/<div[^>]*class="modal-overlay"[^>]*id="([^"]+)"/g) || [])
        .map(function (t) { return t.match(/id="([^"]+)"/)[1] })));
  check("the modals were found", ids.size >= 20, "found " + ids.size);

  const closers = [];
  let m, re = /function ((?:close|hide)\w+)\s*\([^)]*\)\s*\{/g;
  while ((m = re.exec(BLOCK)) !== null) {
    const end = BLOCK.indexOf('\n      }', m.index);
    const body = BLOCK.slice(m.index, end === -1 ? m.index + 1200 : end);
    // ⚠️ BOTH quote styles, for the id and for 'none'. The map's own entries use
    // display = "none" and the first version of this scan only allowed single quotes,
    // so it found 3 of 10 and reported the shortfall as "the function shape changed".
    [...ids].forEach(function (id) {
      const q = "[\"']";
      if (new RegExp("getElementById\\(" + q + id + q + "\\)\\.style\\.display\\s*=\\s*" + q + "none" + q).test(body))
        closers.push({ fn: m[1], id: id });
    });
  }
  check("close* functions that hide a modal were found", closers.length >= 8,
    "found " + closers.length + " — the function shape changed and this scan is blind");
  const missing = closers.filter(function (c) {
    return !new RegExp("'" + c.id + "': function\\(\\) \\{ " + c.fn + "\\(\\)").test(HANDLER); });
  check("⚠️ every one of them is in the closer map", missing.length === 0,
    missing.map(function (c) { return c.id + " -> " + c.fn; }).join(", ") +
    " would get display:none instead, skipping their cleanup");

  // ⚠️ Two that cost real state if the fallback runs, named explicitly because the
  // derivation above cannot see the second one (recUnsavedCancel hides the modal
  // indirectly, through _recUnsavedTake).
  check("⚠️ interviewResultModal uses its closer, which clears _irEditRow",
    /'interviewResultModal': function\(\) \{ closeInterviewResultEntry\(\); \}/.test(HANDLER),
    "otherwise the NEXT open edits the row left over from last time");
  check("⚠️ recUnsavedModal maps to CANCEL, the branch that keeps the work",
    /'recUnsavedModal': function\(\) \{ recUnsavedCancel\(\); \}/.test(HANDLER),
    "it must never map to 保存せずに移動, and display:none would strand the callbacks");
}

console.log("\n4. Esc backs out one level");
{
  check("popovers are closed before modals",
    CODE.indexOf('closeTopPopover()') !== -1
      && CODE.indexOf('if (closeTopPopover()) return;') < CODE.indexOf('closeTopModal();'),
    "otherwise the 出力 menu inside 増減推移 dies with the modal in one keypress");
  check("...covering both dismissible kinds",
    /\.exp-wrap\.open, \.filter-multi\.open/.test(CODE),
    "出力 menus and the 学生一覧 multi-selects both only close on an outside click");
  // Pre-existing and deliberately first: Esc in a non-empty search box clears it.
  // ⚠️ Compared against the CALL, not the name. closeTopPopover's definition sits
  // above the listener, so indexOf('closeTopPopover()') finds the definition and the
  // ordering check reads backwards.
  check("a non-empty search box still takes precedence",
    CODE.indexOf("el.value = ''") !== -1
      && CODE.indexOf("el.value = ''") < CODE.indexOf('if (closeTopPopover()) return;'), "");
  check("both Escape spellings are handled",
    /e\.key !== 'Escape' && e\.key !== 'Esc'/.test(CODE), "");
}

console.log("\n" + (fail === 0 ? "ALL " + pass + " CHECKS PASSED" : pass + " passed, " + fail + " FAILED"));
process.exitCode = fail === 0 ? 0 : 1;
