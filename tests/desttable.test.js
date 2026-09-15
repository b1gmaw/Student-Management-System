// 進路 summary table — markup structure and the grand total.
//
// ⚠️ THIS EXISTS BECAUSE INVALID TABLE MARKUP STILL RENDERS. destRender's cell
// helper is meant to return an OPENING <td> that the caller closes. An earlier
// version returned a COMPLETE cell for zero counts while the caller appended the
// contents anyway:
//
//     <td>0</td>0 0%</td>
//
// The HTML table parser foster-parents that orphaned "0 0%" OUT of the table, so
// it surfaced as stray percentages floating near the table rather than as broken
// cells. Nothing threw, the page looked almost right, and no existing check
// covered it — the suite only ever tested server logic.
//
// So: assert the STRUCTURE, not the appearance.

const escHtmlJs = s => String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
const escAttrJs = s => escHtmlJs(s).replace(/"/g,"&quot;");

const cats = ["進学","就職","帰国","在籍継続","退学・除籍","その他"];

const cellOpen = function (n, cohort, cat, extra) {
  if (!n) return '<td' + (extra || '') + '>';
  return '<td' + (extra || '') + ' style="cursor:pointer; text-decoration:underline dotted;"' +
         ' title="クリックで内訳" data-co="' + escAttrJs(cohort) + '"' +
         ' data-cat="' + escAttrJs(cat) + '" onclick="destShowDetail(this)">';
};
const withPct = function (n, p) {
  return n + ((!n || p === null || p === undefined) ? '' :
    ' <span style="color:var(--text-muted); font-size:11px;">' + p + '%</span>');
};
function line(row, isTotal) {
  const style = isTotal ? ' style="border-top:2px solid var(--border-thick); font-weight:bold;"' : '';
  let t = '<tr' + style + '><td style="text-align:left; font-weight:bold;">' + escHtmlJs(row.cohort) + '</td>';
  cats.forEach(c => { t += cellOpen(row.counts[c]||0, row.cohortKey, c) + withPct(row.counts[c]||0, row.pct[c]) + '</td>'; });
  t += cellOpen(row.known,row.cohortKey,'') + '<b>' + row.known + '</b></td>' +
       cellOpen(row.unentered,row.cohortKey,'未入力') + row.unentered + '</td>' +
       cellOpen(row.unclassified,row.cohortKey,'未分類') + row.unclassified + '</td>' +
       '<td>' + row.rows + '</td></tr>';
  return t;
}
function _destTotalRow(cohorts, cats) {
  let counts={}, known=0, unentered=0, unclassified=0, rows=0;
  cats.forEach(c=>counts[c]=0);
  cohorts.forEach(r=>{ cats.forEach(c=>counts[c]+=(r.counts[c]||0));
    known+=r.known; unentered+=r.unentered; unclassified+=r.unclassified; rows+=r.rows; });
  let pct={}; cats.forEach(c=>pct[c]= known ? Math.round(1000*counts[c]/known)/10 : null);
  return { cohort:'合計', cohortKey:'', counts, pct, known, unentered, unclassified, rows };
}

let p=0,f=0; const ck=(n,c,d)=>c?(p++,console.log("  PASS  "+n)):(f++,console.log("  FAIL  "+n+"\n        "+d));

// A cohort with zeros in most categories — the case that produced stray text.
const mk = (counts, unentered, unclassified) => {
  let known = cats.reduce((n,c)=>n+(counts[c]||0),0);
  let pct={}; cats.forEach(c=>pct[c]= known?Math.round(1000*(counts[c]||0)/known)/10:null);
  return { cohort:'2025.4~2026.3', cohortKey:'2025.4~2026.3', counts, pct, known,
           unentered, unclassified, rows: known+unentered+unclassified };
};
const rows = [ mk({帰国:5}, 0, 0), mk({進学:60,就職:30,帰国:10}, 8, 12) ];

// Structural check: every <td> opened is closed exactly once, and no text sits
// between </td> and the next <td>.
function wellFormed(html) {
  const inner = html.replace(/^<tr[^>]*>/, '').replace(/<\/tr>$/, '');
  const opens = (inner.match(/<td/g)||[]).length;
  const closes = (inner.match(/<\/td>/g)||[]).length;
  const stray = /<\/td>\s*[^<\s]/.test(inner);
  return { opens, closes, stray };
}
rows.concat([_destTotalRow(rows, cats)]).forEach((r,i) => {
  const w = wellFormed(line(r, i===2));
  ck(`row ${i}: <td> opened and closed equally`, w.opens===w.closes, JSON.stringify(w));
  ck(`row ${i}: no orphaned text after </td>`, !w.stray, "text between </td> and the next cell — this is the foster-parenting bug");
  ck(`row ${i}: cell count matches header`, w.opens===cats.length+5, `${w.opens} vs ${cats.length+5}`);
});

// A zero must render bare, with no percentage.
ck("a zero count renders no %", !/0 <span/.test(line(rows[0],false)), line(rows[0],false).slice(0,200));

// Totals arithmetic.
const t = _destTotalRow(rows, cats);
ck("total known sums the cohorts", t.known === 5+100, String(t.known));
ck("total rows sums the cohorts", t.rows === rows[0].rows+rows[1].rows, String(t.rows));
const sum = cats.reduce((n,c)=>n+(t.pct[c]||0),0);
ck("total percentages sum to 100", Math.abs(sum-100) < 0.15, String(sum));
// The weighting trap: averaging per-cohort percentages would give 帰国 far more.
const naive = cats.map(c => (rows.reduce((n,r)=>n+(r.pct[c]||0),0)/rows.length));
ck("weighted by size, not averaged across cohorts",
   Math.abs(t.pct['帰国'] - naive[cats.indexOf('帰国')]) > 1,
   `weighted ${t.pct['帰国']}% vs naive average ${naive[cats.indexOf('帰国')]}% — these must differ`);
ck("the total row opens all cohorts", t.cohortKey === '', t.cohortKey);
// ---- 集計表 cross-tabs: something × 区分, one renderer, five row fields ----
// Transcribed from destRenderPivot.
function crossTab(rows, field, sparse) {
  const used = sparse ? rows.filter(r => (r[field] || '').trim() !== '') : rows;
  let by = {};
  used.forEach(r => {
    const k = (r[field] || '').trim() || '(未記入)';
    if (!by[k]) by[k] = {};
    by[k][r.category] = (by[k][r.category] || 0) + 1;
  });
  const summarise = (label, counts) => {
    let known = 0;
    cats.forEach(c => known += (counts[c] || 0));
    let pct = {};
    cats.forEach(c => pct[c] = known ? Math.round(1000 * (counts[c] || 0) / known) / 10 : null);
    const un = counts['未入力'] || 0, nc = counts['未分類'] || 0;
    return { label, counts, pct, known, unentered: un, unclassified: nc, rows: known + un + nc };
  };
  let lines = Object.keys(by).map(k => summarise(k, by[k]));
  let totals = {};
  used.forEach(r => totals[r.category] = (totals[r.category] || 0) + 1);
  return { lines, total: summarise('合計', totals), used: used.length, all: rows.length };
}

// A small population with a deliberate shape: Nepal skews 就職, Vietnam skews
// 進学, and only some rows carry 業種.
const POP = [
  { cohort:'2025.4~2026.3', nationality:'ネパール', course:'進学2年課程', industry:'IT',   category:'就職' },
  { cohort:'2025.4~2026.3', nationality:'ネパール', course:'進学2年課程', industry:'飲食', category:'就職' },
  { cohort:'2025.4~2026.3', nationality:'ネパール', course:'進学2年課程', industry:'',     category:'進学' },
  { cohort:'2025.4~2026.3', nationality:'ベトナム', course:'進学2年課程', industry:'',     category:'進学' },
  { cohort:'2025.4~2026.3', nationality:'ベトナム', course:'進学2年課程', industry:'',     category:'進学' },
  { cohort:'2024.4~2025.3', nationality:'ベトナム', course:'就職2年課程', industry:'',     category:'帰国' },
  { cohort:'2024.4~2025.3', nationality:'ネパール', course:'就職2年課程', industry:'',     category:'未入力' },
  { cohort:'2024.4~2025.3', nationality:'ベトナム', course:'就職2年課程', industry:'',     category:'未分類' }
];

console.log("\n=== 集計表 cross-tabs ===");
{
  const ct = crossTab(POP, 'nationality', false);

  // Structure, the same discipline as the summary table above.
  ct.lines.concat([ct.total]).forEach((r, i) => {
    const w = wellFormed(line({ cohort: r.label, cohortKey: '', counts: r.counts, pct: r.pct,
                                known: r.known, unentered: r.unentered,
                                unclassified: r.unclassified, rows: r.rows }, i === ct.lines.length));
    ck(`cross-tab row ${i}: <td> balanced`, w.opens === w.closes, JSON.stringify(w));
    ck(`cross-tab row ${i}: no orphaned text`, !w.stray, "foster-parenting bug");
  });

  // ⚠️ The check that matters most: a cross-tab and the summary must agree, or
  // one of them is lying to whoever reports these numbers upward.
  cats.forEach(c => {
    const viaCross = ct.lines.reduce((n, r) => n + (r.counts[c] || 0), 0);
    const direct = POP.filter(r => r.category === c).length;
    ck(`国籍 cross-tab agrees with the direct count for ${c}`, viaCross === direct,
       `${viaCross} vs ${direct}`);
  });
  ck("every row is accounted for", ct.total.rows === POP.length, `${ct.total.rows} vs ${POP.length}`);

  // Percentages are of THAT ROW's known outcomes.
  const nepal = ct.lines.find(r => r.label === 'ネパール');
  ck("ネパール known excludes 未入力", nepal.known === 3, String(nepal.known));
  ck("ネパール 就職 is 66.7% of its own known", nepal.pct['就職'] === 66.7, String(nepal.pct['就職']));
  const rowSum = cats.reduce((n, c) => n + (nepal.pct[c] || 0), 0);
  ck("a row's percentages sum to 100", Math.abs(rowSum - 100) < 0.15, String(rowSum));

  // A row with no known outcomes must not produce NaN.
  const onlyUnknown = crossTab([{ nationality:'X', category:'未入力' }], 'nationality', false);
  ck("a row with 0 known yields null, not NaN",
     onlyUnknown.lines[0].pct['進学'] === null, JSON.stringify(onlyUnknown.lines[0].pct));
  ck("and still counts toward 合計", onlyUnknown.lines[0].rows === 1, "");
}

console.log("\n=== sparse fields state their coverage ===");
{
  // 業種 is filled on well under half the rows. Dropping blanks silently would
  // present a subset as the whole picture.
  const ct = crossTab(POP, 'industry', true);
  ck("業種 view covers only the filled rows", ct.used === 2, String(ct.used));
  ck("and knows the full population for the note", ct.all === POP.length, String(ct.all));
  ck("no (未記入) row appears when blanks are excluded",
     !ct.lines.some(r => r.label === '(未記入)'), JSON.stringify(ct.lines.map(r => r.label)));
  // Without the sparse flag the blanks would form their own row instead.
  const ct2 = crossTab(POP, 'industry', false);
  ck("unfiltered, blanks become an explicit (未記入) row",
     ct2.lines.some(r => r.label === '(未記入)'), JSON.stringify(ct2.lines.map(r => r.label)));
}

console.log("\n=== 推移 matches the per-cohort summary ===");
{
  const ct = crossTab(POP, 'cohort', false);
  const byCohort = {};
  POP.forEach(r => byCohort[r.cohort] = (byCohort[r.cohort] || 0) + 1);
  ct.lines.forEach(r => {
    ck(`推移 row ${r.label} totals match a direct count`, r.rows === byCohort[r.label],
       `${r.rows} vs ${byCohort[r.label]}`);
  });
  ck("推移 is ordered newest first",
     ct.lines[0].label === '2025.4~2026.3', ct.lines.map(r => r.label).join(' | '));
}

console.log(f===0 ? `\nALL ${p} CHECKS PASSED` : `\n${p} passed, ${f} FAILED`);
process.exitCode = f?1:0;
