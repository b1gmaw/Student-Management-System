// Bulk dorm PDF export must produce the SAME document as the single-room export.
//
// Two bugs motivated this suite, both silent — no error, just a wrong PDF:
//
//  A. combineRoomHtmlToPdf nested N complete html documents inside a fresh
//     wrapper that had no <!DOCTYPE html>. Missing doctype means QUIRKS MODE,
//     and in quirks mode a font-size set on body does not inherit into <table>
//     elements — they reset to the default ~16px. Template.html is almost
//     entirely tables, so the bulk export's text came out visibly larger.
//  B. getBuildingRoomsForExport supplied none of the six per-room bill
//     overrides, so bulk PDFs printed the BUILDING default for any room that
//     had one. Wrong billing figures on a document handed to tenants.
//
// Check 4 is the one that would have caught B, and is the one most likely to
// catch the next field someone adds to _buildRoomHtml_ but forgets here.

let pass = 0, fail = 0;
function check(n, c, d) {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + "\n        " + d); }
}

// ---- Transcribed from Code.js ----
function _htmlHeadInner_(doc) {
  const m = String(doc).match(/<head[^>]*>([\s\S]*?)<\/head>/i);
  return m ? m[1] : '';
}
function _htmlBodyInner_(doc) {
  const m = String(doc).match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  return m ? m[1] : String(doc);
}
function combine(frags, templateHead) {
  frags = frags || [];
  let headInner = frags.length ? _htmlHeadInner_(frags[0]) : '';
  if (!headInner) headInner = _htmlHeadInner_(templateHead || '');
  let combined = '<!DOCTYPE html><html><head>' + headInner + '</head><body>';
  frags.forEach(function (frag, idx) {
    let isLast = (idx === frags.length - 1);
    combined += '<div style="' + (isLast ? '' : 'page-break-after: always;') + '">'
              + _htmlBodyInner_(frag) + '</div>';
  });
  return combined + '</body></html>';
}

// A stand-in for what _buildRoomHtml_ returns: a complete document.
const roomDoc = (n) =>
  '<!DOCTYPE html>\n<html>\n<head>\n<meta charset="UTF-8">\n<title>Dormitory Information</title>\n' +
  '<style>\n@page { size: A4; margin: 10mm; }\nbody { font-size: 11px; }\n</style>\n</head>\n' +
  '<body>\n<table class="info-table"><tr><td>Room ' + n + '</td></tr></table>\n</body>\n</html>';

console.log("\n1. Fragment extraction");
{
  check("body inner is extracted, tags excluded",
    _htmlBodyInner_(roomDoc(101)).indexOf('Room 101') !== -1 &&
    _htmlBodyInner_(roomDoc(101)).indexOf('<body') === -1,
    JSON.stringify(_htmlBodyInner_(roomDoc(101)).slice(0, 60)));

  check("head inner carries the style",
    _htmlHeadInner_(roomDoc(1)).indexOf('font-size: 11px') !== -1, "style lost");

  check("head inner excludes the head tags themselves",
    _htmlHeadInner_(roomDoc(1)).indexOf('<head') === -1, "head tag leaked");

  // <body> may legitimately carry attributes; the regex must still match.
  const withAttrs = '<html><head><style>x{}</style></head><body class="p" style="margin:0">KEEP</body></html>';
  check("body with attributes still matches", _htmlBodyInner_(withAttrs).trim() === 'KEEP',
    JSON.stringify(_htmlBodyInner_(withAttrs)));

  // A bare fragment must pass THROUGH, not become empty — returning '' here
  // would silently drop a room from the PDF.
  check("bare fragment passes through unchanged",
    _htmlBodyInner_('<div>no body tag</div>') === '<div>no body tag</div>',
    JSON.stringify(_htmlBodyInner_('<div>no body tag</div>')));

  check("missing head yields empty string, not null",
    _htmlHeadInner_('<div>nope</div>') === '', "got " + JSON.stringify(_htmlHeadInner_('<div>nope</div>')));
}

console.log("\n2. The combined document is ONE valid document");
{
  const out = combine([roomDoc(101), roomDoc(102), roomDoc(103)]);
  const count = (s, re) => (s.match(re) || []).length;

  // Bug A: this is the whole fix. No doctype = quirks mode = big table text.
  check("starts with a doctype", /^<!DOCTYPE html>/i.test(out), out.slice(0, 40));
  check("exactly one <html>", count(out, /<html[\s>]/gi) === 1, String(count(out, /<html[\s>]/gi)));
  check("exactly one <head>", count(out, /<head[\s>]/gi) === 1, String(count(out, /<head[\s>]/gi)));
  check("exactly one <body>", count(out, /<body[\s>]/gi) === 1, String(count(out, /<body[\s>]/gi)));
  check("exactly one <style>", count(out, /<style[\s>]/gi) === 1, String(count(out, /<style[\s>]/gi)));
  check("no nested doctype", count(out, /<!DOCTYPE/gi) === 1, String(count(out, /<!DOCTYPE/gi)));
  check("no stray <title> in the body",
    out.slice(out.indexOf('<body')).indexOf('<title') === -1, "title leaked into body");

  check("the style survives exactly once", count(out, /font-size: 11px/g) === 1,
    String(count(out, /font-size: 11px/g)));
  check("@page survives", out.indexOf('@page') !== -1, "@page lost");

  check("every room's content is present",
    ['Room 101', 'Room 102', 'Room 103'].every(r => out.indexOf(r) !== -1), out.length + " chars");
}

console.log("\n3. Page breaks");
{
  const out = combine([roomDoc(1), roomDoc(2), roomDoc(3)]);
  const breaks = (out.match(/page-break-after: always/g) || []).length;
  check("n-1 page breaks for n rooms", breaks === 2, String(breaks));

  const one = combine([roomDoc(1)]);
  check("a single room gets no trailing break",
    (one.match(/page-break-after/g) || []).length === 0, "trailing break would add a blank page");
  check("a single room still produces a valid document",
    /^<!DOCTYPE html>/i.test(one) && one.indexOf('font-size: 11px') !== -1, one.slice(0, 60));

  // Empty list: must still be a valid document, and must fall back to the
  // template for the head rather than emitting an unstyled shell.
  const none = combine([], roomDoc(0));
  check("empty list falls back to the template head",
    none.indexOf('font-size: 11px') !== -1, "styles lost on empty input");
}

console.log("\n4. Field parity: bulk export supplies everything _buildRoomHtml_ reads");
{
  // Mirrors roomData.* reads in _buildRoomHtml_.
  const NEEDED = [
    'roomNumber', 'rentPrice', 'mailboxCode', 'deliveryBoxCode', 'wifiInfo',
    'bicycleNumber', 'roomCode',
    'waterBillOverride', 'hotWaterBillOverride', 'elecBillOverride',
    'gasBillOverride', 'internetBillOverride', 'otherBillOverride',
  ];
  // Mirrors the object getBuildingRoomsForExport pushes.
  const BULK = [
    'rowIndex', 'building', 'roomNumber', 'rentPrice', 'mailboxCode',
    'deliveryBoxCode', 'wifiInfo', 'status', 'bicycleNumber', 'studentId',
    'studentName', 'nationality', 'studentClass', 'roomCode', 'remarks',
    'waterBillOverride', 'elecBillOverride', 'gasBillOverride',
    'internetBillOverride', 'otherBillOverride', 'hotWaterBillOverride',
  ];
  // Mirrors getDormData's room object — the single export's source, and the
  // reference the bulk list has to match. Transcribed independently from
  // getDormData rather than copied from BULK: copying would make the comparison
  // below tautological, which is worse than no check at all because it looks
  // like coverage.
  const SINGLE = [
    'rowIndex', 'building', 'roomNumber', 'rentPrice', 'mailboxCode',
    'deliveryBoxCode', 'wifiInfo', 'status', 'bicycleNumber', 'studentId',
    'studentName', 'nationality', 'studentClass', 'roomCode', 'remarks',
    'waterBillOverride', 'elecBillOverride', 'gasBillOverride',
    'internetBillOverride', 'otherBillOverride', 'hotWaterBillOverride',
  ];

  NEEDED.forEach(function (f) {
    check(f + " supplied by bulk export", BULK.indexOf(f) !== -1,
      "bulk PDF would render this as empty or fall back to the building default");
  });

  check("bulk and single sources agree on every needed field",
    NEEDED.every(f => (BULK.indexOf(f) !== -1) === (SINGLE.indexOf(f) !== -1)),
    "the two export paths would render differently: " +
    NEEDED.filter(f => (BULK.indexOf(f) !== -1) !== (SINGLE.indexOf(f) !== -1)).join(", "));

  // Stronger than the per-field checks: the two sources must expose the SAME
  // set, so a field added to one path and not the other is caught even if
  // _buildRoomHtml_ does not read it yet.
  const onlyBulk = BULK.filter(f => SINGLE.indexOf(f) === -1);
  const onlySingle = SINGLE.filter(f => BULK.indexOf(f) === -1);
  check("neither source has a field the other lacks",
    onlyBulk.length === 0 && onlySingle.length === 0,
    "bulk-only: [" + onlyBulk.join(", ") + "]  single-only: [" + onlySingle.join(", ") + "]");

  // The six that were actually missing, called out so a regression names itself.
  ['waterBillOverride', 'hotWaterBillOverride', 'elecBillOverride',
   'gasBillOverride', 'internetBillOverride', 'otherBillOverride'].forEach(function (f) {
    check("bill override present: " + f, BULK.indexOf(f) !== -1,
      "this is the exact field that printed the building default on bulk PDFs");
  });
}

console.log("\n" + (fail === 0 ? "ALL " + pass + " CHECKS PASSED" : pass + " passed, " + fail + " FAILED"));
process.exitCode = fail === 0 ? 0 : 1;
