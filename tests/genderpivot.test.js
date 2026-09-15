// 学生数 → 性別集計: country rows × (入学期・コース | ビザ) column groups,
// every group split by gender.
//
// Purely client-side — currentStudentsData already holds the whole of Central_DB —
// so the risk is not access control, it is arithmetic that quietly disagrees with
// the 学生数 table right behind it. Four ways that happens:
//
//   1. Every group covers the SAME population, so on any row the 入学期・コース
//      group and the ビザ group must each sum to that row's 合計. On a 40-column
//      table, a group that drops rows is exactly what nobody notices.
//      ⚠️ cohort is ONE group whose members are intake+course, not one group per
//      intake — that is what keeps this invariant, and the no-early-return guard,
//      meaningful.
//   2. コース is written several ways for one course: an NN期_ prefix on 262 of 608
//      Central_DB rows, a stray （一般）, and カ/ヵ/ヶ/か variants (§9.1). Each
//      un-collapsed variant is a duplicate column.
//   3. Central_DB has no 入学期 column — intake is the YYYYMM prefix of 学籍番号.
//   4. 男/女 are not the only values. その他 and blanks go in a 他 column, which
//      appears only when needed; they are never dropped.
//
// ビザ groups as 留学 vs その他, matching getLiveReportData's
// `if (visa !== "留学")` — that function produces the report this modal opens
// from, so one rule rather than two keeps the numbers explicable to each other.
//
// ⚠️ This suite has TWICE had a mutation slip past its transcription-only half.
// Every behavioural claim below has a matching read of Index.html in section 7.

const fs = require('fs');
const path = require('path');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'Index.html'), 'utf8');

let pass = 0, fail = 0;
function check(n, c, d) {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + "\n        " + d); }
}

// ---- transcribed from Index.html -------------------------------------------
const GROUPS = ['cohort', 'visa'];
const SEP = '\u0000';
function normName(s) { return String(s == null ? '' : s).replace(/[\s　]/g, '').trim(); }
function _simNormCourseJs(s) {
  return String(s == null ? '' : s).replace(/[\s　]/g, '').replace(/[カヵヶ]/g, 'か');
}
function _stuCol(headers, name) {
  for (let i = 0; i < headers.length; i++) {
    if (String(headers[i] || '').trim() === name) return i;
  }
  return -1;
}
function _stuVisaCol(headers) {
  const want = ['ビザの種類', 'ビザ', '在留資格'];
  for (let i = 0; i < headers.length; i++) {
    const h = String(headers[i] || '').replace(/[\s　]/g, '');
    for (let j = 0; j < want.length; j++) {
      if (h === want[j] || h.indexOf(want[j]) !== -1) return i;
    }
  }
  return -1;
}
function _stuIsStudentVisa(raw) {
  return String(raw == null ? '' : raw).replace(/[\s　]/g, '') === '留学';
}
function _stuCourseLabel(raw) {
  let s = String(raw == null ? '' : raw).trim();
  const u = s.indexOf('_');
  if (u !== -1) {
    const p = s.substring(0, u).trim();
    if (/^\d{1,3}\s*期$/.test(p) || /^\d{6}$/.test(p)) s = s.substring(u + 1).trim();
  }
  s = s.replace(/[（(]一般[）)]/g, '').replace(/\d+期/g, '').trim();
  s = _simNormCourseJs(s);
  if (s === '') return '(未記入)';
  if (s === '日本語・文化2年課程') return '文化';
  if (s === '就職2年課程') return '就職';
  if (s.indexOf('進学') === 0 && s.lastIndexOf('課程') === s.length - 2) {
    return s.substring(0, s.length - 2);
  }
  return s;
}
function _stuIntakeLabel(sid) {
  const s = String(sid == null ? '' : sid).trim();
  if (!/^\d{6}/.test(s)) return '(不明)';
  const y = parseInt(s.substring(0, 4), 10), mo = parseInt(s.substring(4, 6), 10);
  if (isNaN(y) || isNaN(mo) || y < 2000 || y > 2100 || mo < 1 || mo > 12) return '(不明)';
  return y + '-' + (mo < 10 ? '0' + mo : mo);
}
function _stuGenderLabel(raw) {
  const s = normName(String(raw == null ? '' : raw));
  if (s === '男' || s === '男性' || s === 'M' || s === 'MALE') return '男';
  if (s === '女' || s === '女性' || s === 'F' || s === 'FEMALE') return '女';
  if (s === '') return '未記入';
  return 'その他';
}

function run(data) {
  const h = data[0];
  const iNat = _stuCol(h, '国名'), iCourse = _stuCol(h, 'コース');
  const iGender = _stuCol(h, '性別'), iId = _stuCol(h, '学籍番号');
  const iVisa = _stuVisaCol(h);

  let rows = [];
  for (let i = 1; i < data.length; i++) {
    const r = data[i];
    if (!r) continue;
    if (iId !== -1 && String(r[iId] || '').trim() === '') continue;
    rows.push(r);
  }
  const genderOf = function (r) {
    const g = _stuGenderLabel(r[iGender]);
    return (g === '男' || g === '女') ? g : '他';
  };
  const needsOther = rows.some(function (r) { return genderOf(r) === '他'; });
  const GENDERS = needsOther ? ['男', '女', '他'] : ['男', '女'];
  const memberOf = function (key, r) {
    if (key === 'cohort') {
      const it = iId === -1 ? '(不明)' : _stuIntakeLabel(r[iId]);
      const co = iCourse === -1 ? '(不明)' : _stuCourseLabel(r[iCourse]);
      return it + SEP + co;
    }
    if (iVisa === -1) return '(不明)';
    return _stuIsStudentVisa(r[iVisa]) ? '留学' : 'その他';
  };
  const countryOf = function (r) {
    return iNat === -1 ? '(不明)' : (String(r[iNat] || '').trim() || '(未記入)');
  };

  let members = {};
  GROUPS.forEach(function (gk) {
    let seen = {};
    rows.forEach(function (r) { const m = memberOf(gk, r); seen[m] = (seen[m] || 0) + 1; });
    let keys = Object.keys(seen);
    if (gk === 'cohort') {
      keys.sort(function (a, b) {
        const ia = a.split(SEP)[0], ib = b.split(SEP)[0];
        if (ia !== ib) return ia < ib ? 1 : -1;
        return seen[b] - seen[a];
      });
    } else {
      keys.sort(function (a, b) { return seen[b] - seen[a]; });
    }
    members[gk] = keys;
  });

  let cell = {}, countryTotal = {}, grand = {};
  rows.forEach(function (r) {
    const c = countryOf(r), gd = genderOf(r);
    if (!cell[c]) {
      cell[c] = {};
      GROUPS.forEach(function (gk) { cell[c][gk] = {}; });
      countryTotal[c] = {}; GENDERS.forEach(function (x) { countryTotal[c][x] = 0; });
    }
    GROUPS.forEach(function (gk) {
      const m = memberOf(gk, r);
      if (!cell[c][gk][m]) { cell[c][gk][m] = {}; GENDERS.forEach(function (x) { cell[c][gk][m][x] = 0; }); }
      cell[c][gk][m][gd]++;
    });
    countryTotal[c][gd]++;
    grand[gd] = (grand[gd] || 0) + 1;
  });
  const countries = Object.keys(cell).sort(function (a, b) {
    const ta = GENDERS.reduce(function (s, g) { return s + countryTotal[a][g]; }, 0);
    const tb = GENDERS.reduce(function (s, g) { return s + countryTotal[b][g]; }, 0);
    return tb - ta;
  });
  return { rows: rows, GENDERS: GENDERS, members: members, cell: cell,
           countryTotal: countryTotal, grand: grand, countries: countries, visaCol: iVisa };
}
function groupSum(r, country, gk) {
  return r.members[gk].reduce(function (s, m) {
    const c = r.cell[country][gk][m];
    return s + (c ? r.GENDERS.reduce(function (x, g) { return x + c[g]; }, 0) : 0);
  }, 0);
}
function rowTotal(r, country) {
  return r.GENDERS.reduce(function (s, g) { return s + r.countryTotal[country][g]; }, 0);
}

// Representative data: the shapes that actually appear in Central_DB.
const HEADERS = ['学籍番号', 'ニックネーム', '国名', '性別', 'コース', 'ビザの種類'];
const ROWS = [
  ['202604001', 'A', 'ネパール', '男',    '83期_進学1年6カ月課程', '留学'],
  ['202604002', 'B', 'ネパール', '女',    '進学1年6ヶ月課程',      '留学'],    // kana variant
  ['202604003', 'C', 'ベトナム', '女',    '83期_進学2年課程',      '留学'],
  ['202601004', 'D', 'ベトナム', '',       '進学2年課程',           '家族滞在'], // blank gender
  ['202601005', 'E', '中国',     'その他', '202601_進学2年課程',    '就労'],
  ['badid',     'F', '中国',     '男',    '',                       '留学'],    // malformed id
  ['202604007', 'G', '',         'M',     '83期_進学1年6ヵ月課程', '留学'],    // blank country
  ['202604008', 'H', 'ネパール', '男',    '進学1年6か月課程（一般）', '留学'],  // （一般）
  ['202604009', 'I', 'タイ',     '女',    '日本語・文化2年課程',   ''],        // blank visa
  ['',          '',  '',         '',      '',                       ''],       // spacer, not a student
  ['202604011', 'K', 'タイ',     '女',    '進学2年課程',           '　留学　'] // full-width padding
];
const DATA = [HEADERS].concat(ROWS);
const N = 10;   // 11 rows minus the spacer

console.log("\n1. every student is counted — nothing is filtered out");
{
  const r = run(DATA);
  check("the visa column is found", r.visaCol === 5, "got " + r.visaCol);
  // ⚠️ The 留学-only filter is GONE. ビザ is a breakdown now, so excluding
  // non-student visas would empty the group that exists to show them.
  check("all students are kept", r.rows.length === N, r.rows.length + " vs " + N);
  check("a spacer row with no 学籍番号 is not a student",
    !r.rows.some(function (x) { return String(x[0]).trim() === ''; }), "");
  const total = r.GENDERS.reduce(function (s, g) { return s + (r.grand[g] || 0); }, 0);
  check("the grand total equals the roster", total === N, total + " vs " + N);
}

console.log("\n2. ビザ groups as 留学 vs その他");
{
  const r = run(DATA);
  check("the group has exactly two members",
    r.members.visa.length === 2 && r.members.visa.indexOf('留学') !== -1 &&
    r.members.visa.indexOf('その他') !== -1, r.members.visa.join(" | "));

  const visaCount = function (m) {
    return r.countries.reduce(function (s, c) {
      const cc = r.cell[c].visa[m];
      return s + (cc ? r.GENDERS.reduce(function (x, g) { return x + cc[g]; }, 0) : 0);
    }, 0);
  };
  // 留学: A B C F G H K = 7.  その他: D(家族滞在) E(就労) I(blank) = 3.
  check("留学 counts 7", visaCount('留学') === 7, "got " + visaCount('留学'));
  check("家族滞在 / 就労 / blank all fold into その他", visaCount('その他') === 3,
    "got " + visaCount('その他'));
  // ⚠️ §9.2: a value padded with U+3000 looks identical and compares different.
  check("留学 padded with full-width spaces still counts as 留学",
    r.cell['タイ'].visa['留学'] !== undefined,
    "the ideographic-space case silently moves a real student into その他");
  check("_stuIsStudentVisa is exact, not a prefix match",
    _stuIsStudentVisa('留学') && !_stuIsStudentVisa('留学生') && !_stuIsStudentVisa('元留学'),
    "a substring match would sweep in labels that are not the student visa");
}

console.log("\n3. every group agrees with its row total");
{
  // ⚠️ THE check that makes a 40-column table trustworthy.
  const r = run(DATA);
  r.countries.forEach(function (c) {
    const t = rowTotal(r, c);
    GROUPS.forEach(function (gk) {
      check(c + ": the " + gk + " group sums to " + t, groupSum(r, c, gk) === t,
        groupSum(r, c, gk) + " vs " + t);
    });
  });
  const sumRows = r.countries.reduce(function (s, c) { return s + rowTotal(r, c); }, 0);
  check("the country rows sum to the roster", sumRows === N, sumRows + " vs " + N);
}

console.log("\n4. 入学期 and コース are one combined dimension");
{
  const r = run(DATA);
  const parts = r.members.cohort.map(function (m) { return m.split(SEP); });
  check("every member splits into exactly an intake and a course",
    parts.every(function (p) { return p.length === 2 && p[0] && p[1]; }),
    JSON.stringify(r.members.cohort.map(function (m) { return m.replace(SEP, ' | '); })));

  // ⚠️ The same course in two intakes must stay two columns — that is the whole
  // point of combining them. 進学2年 appears in 2026-04 (C) and 2026-01 (D, E).
  const shin2 = parts.filter(function (p) { return p[1] === '進学2年'; });
  check("one course in two intakes yields two members", shin2.length === 2,
    shin2.map(function (p) { return p.join('/'); }).join(" | "));
  check("their intakes differ", shin2.length === 2 && shin2[0][0] !== shin2[1][0], "");

  // ⚠️ The header spans an intake by walking runs of consecutive members, so
  // members sharing an intake MUST be adjacent. Interleaved, the colspan would be
  // wrong and the columns would sit under the wrong intake — silently.
  let seenIntakes = [], last = null;
  parts.forEach(function (p) {
    if (p[0] !== last) { seenIntakes.push(p[0]); last = p[0]; }
  });
  check("members are intake-major, so header runs are contiguous",
    seenIntakes.length === new Set(seenIntakes).size,
    "an intake appears in more than one run: " + seenIntakes.join(" | "));
  const known = seenIntakes.filter(function (i) { return i !== '(不明)'; });
  check("intakes run newest first",
    known.join(',') === known.slice().sort().reverse().join(','), known.join(" | "));

  // ⚠️ The separator must be invisible. A visible one (／, a space) can occur
  // inside a course name and would split the label in the wrong place.
  check("the separator cannot occur in real data", SEP === '\u0000', JSON.stringify(SEP));
  check("no course label contains the separator",
    parts.every(function (p) { return p[1].indexOf(SEP) === -1; }), "");
}

console.log("\n5. course variants collapse within an intake");
{
  const r = run(DATA);
  const courses = r.members.cohort
    .filter(function (m) { return m.split(SEP)[0] === '2026-04'; })
    .map(function (m) { return m.split(SEP)[1]; });
  // A(カ) B(ヶ) G(ヵ) H(か+（一般）) are all 2026-04 進学1年6か月 — one column.
  check("カ / ヶ / ヵ / か collapse to one column",
    courses.filter(function (c) { return c.indexOf('進学1年6') === 0; }).length === 1,
    courses.join(" | "));
  check("（一般） is stripped",
    !courses.some(function (c) { return c.indexOf('一般') !== -1; }), courses.join(" | "));
  check("no column still carries a 期 prefix",
    r.members.cohort.every(function (m) { return !/\d+期/.test(m.split(SEP)[1]); }),
    r.members.cohort.join(" | "));
  check("the report's shortening is applied",
    _stuCourseLabel('日本語・文化2年課程') === '文化' &&
    _stuCourseLabel('就職2年課程') === '就職' &&
    _stuCourseLabel('進学2年課程') === '進学2年', "");
  check("a blank course is bucketed, not dropped",
    r.members.cohort.some(function (m) { return m.split(SEP)[1] === '(未記入)'; }),
    r.members.cohort.join(" | "));
  check("a malformed 学籍番号 becomes intake (不明) rather than disappearing",
    r.members.cohort.some(function (m) { return m.split(SEP)[0] === '(不明)'; }),
    r.members.cohort.join(" | "));
  check("an impossible month is rejected", _stuIntakeLabel('202613001') === '(不明)', "");
  check("the month is zero-padded", _stuIntakeLabel('202604001') === '2026-04', "");
}

console.log("\n6. the 他 column appears only when it is needed");
{
  // ⚠️ その他 and blanks must never be dropped — but a column of zeros across
  // every group on a 40-column table is noise. So the schema is decided once for
  // the whole render, from whether ANY student needs it.
  const r = run(DATA);
  check("他 is present when a blank/その他 exists", r.GENDERS.length === 3 &&
    r.GENDERS[2] === '他', r.GENDERS.join(" | "));
  const otherCount = r.countries.reduce(function (s, c) { return s + (r.countryTotal[c]['他'] || 0); }, 0);
  check("both the blank and the その他 landed there", otherCount === 2, "got " + otherCount);

  const clean = [HEADERS].concat(ROWS.filter(function (x) {
    return x[3] === '男' || x[3] === '女' || x[3] === 'M';
  }));
  const c = run(clean);
  check("他 is absent when every student is 男/女", c.GENDERS.length === 2,
    c.GENDERS.join(" | "));
  const cTotal = c.countries.reduce(function (s, k) { return s + rowTotal(c, k); }, 0);
  check("and nobody is lost by leaving it out", cTotal === c.rows.length,
    cTotal + " vs " + c.rows.length);
}

console.log("\n7. the source matches the transcription");
{
  check("the modal markup exists", /id="stuGenderModal"/.test(HTML), "");
  check("the button opens it", /onclick="stuOpenGender\(\)"/.test(HTML), "");
  check("the 増減推移 button still exists", /onclick="stuOpenTrend\(\)"/.test(HTML), "");

  // The previous two shapes are gone, both halves — half-removed is worse than
  // either design (sidebar.test.js §1, same rule).
  ['STU_GENDER_VIEWS', 'STU_GENDER_SECTIONS', 'stuGenderViews', 'stuSetGenderView']
    .forEach(function (n) {
      check("no trace of the older layouts: " + n, HTML.indexOf(n) === -1, "");
    });
  check("the groups are 入学期・コース then ビザ",
    /STU_GENDER_GROUPS = \[[\s\S]{0,200}?'cohort'[\s\S]{0,140}?'visa'/.test(HTML),
    "the column order is the thing that was asked for");
  check("入学期 and コース are combined, not separate groups",
    HTML.indexOf("{ key: 'course', label: 'コース' }") === -1 &&
    HTML.indexOf("{ key: 'intake', label: '入学期' }") === -1,
    "half-combined would leave duplicate columns");

  const rAt = HTML.indexOf('function stuRenderGender');
  const rBody = HTML.slice(rAt, HTML.indexOf('\n      // ---- 学生数 → 増減推移', rAt));
  check("stuRenderGender's body was located", rAt !== -1 && rBody.length > 1000,
    "every assertion below is vacuous until this passes");

  check("国籍 is the row and is sticky",
    /<td class="sticky-col"/.test(rBody) && /rowspan="3"[\s\S]{0,40}国籍/.test(rBody),
    "a 40-column table with a scrolling first column is unreadable");
  check("合計 is the last group, not the first",
    rBody.indexOf('>合計<') > rBody.lastIndexOf("escHtmlJs(g.label)"),
    "'total at the end' — the group loop must run before the 合計 columns");
  check("no student is filtered out of the pivot",
    !/_stuIsStudentVisa\(r\[iVisa\]\)\) \{ excluded/.test(rBody) && !/excluded\+\+/.test(rBody),
    "the ビザ group exists to show non-student visas; filtering them empties it");
  check("visa is a LABEL, not a gate",
    /_stuIsStudentVisa\(r\[iVisa\]\) \? '留学' : 'その他'/.test(rBody),
    "matching getLiveReportData's 留学/その他 split");
  check("the 他 column is conditional on the data",
    /needsOther \? \['男', '女', '他'\] : \['男', '女'\]/.test(rBody),
    "always-on is noise; never-on drops students");
  check("その他 and blanks fold into 他 rather than being dropped",
    /\(g === '男' \|\| g === '女'\) \? g : '他'/.test(rBody), "");
  check("cohort members are ordered intake-major, newest first",
    /g\.key === 'cohort'/.test(rBody) && /ia < ib \? 1 : -1/.test(rBody) &&
    /seen\[b\] - seen\[a\]/.test(rBody),
    "the header spans an intake by walking consecutive members; any other order " +
    "puts columns under the wrong intake");
  check("the header spans each intake across its courses",
    /colspan="' \+ \(n \* span\)/.test(rBody) && /split\(STU_COHORT_SEP\)\[0\]/.test(rBody), "");
  check("the separator is invisible, so a course name cannot split it",
    /const STU_COHORT_SEP = '\\u0000';/.test(HTML),
    "a visible separator can occur inside a course name");

  // ⚠️ Twice now a mutation has survived because the behavioural half runs the
  // transcription. Every kept row must reach the increment: no early return in
  // the counting loop.
  const cAt = rBody.indexOf('rows.forEach(function (r) {\n          const c = countryOf(r)');
  const cBody = rBody.slice(cAt, rBody.indexOf('const countries =', cAt));
  check("the counting loop was located", cAt !== -1 && cBody.length > 200, "");
  check("no group skips a row while counting", !/\breturn\s*;/.test(cBody),
    "an early return drops rows from ONE group, and a comparison against a clean " +
    "transcription will not notice");

  const cl = HTML.indexOf('function _stuCourseLabel');
  const clBody = HTML.slice(cl, HTML.indexOf('\n      }', cl));
  check("the real _stuCourseLabel strips the 期 prefix",
    /\/\^\\d\{1,3\}\\s\*期\$\//.test(clBody), "");
  check("it collapses kana variants through _simNormCourseJs",
    /_simNormCourseJs\(s\)/.test(clBody),
    "without this, 進学1年6カ月 and 進学1年6ヶ月 become two columns of one course");
  check("it strips （一般）", /一般/.test(clBody), "");
  check("the real _stuIntakeLabel reads the 学籍番号 prefix",
    /s\.substring\(0, 4\)/.test(HTML.slice(HTML.indexOf('function _stuIntakeLabel'),
      HTML.indexOf('function _stuIntakeLabel') + 500)), "");

  check("an unloaded roster is reported, not shown as zero",
    /学生データが読み込まれていません/.test(HTML), "");
  // ⚠️ Plain wording plus a code, not the tab name — see tests/wording.test.js.
  check("a missing 性別 column is reported",
    /学生データに「性別」の項目が見つかりません。（STU-02）/.test(HTML), "");
  check("a missing ビザ column is announced",
    /ビザの種類 列が見つかりません/.test(HTML),
    "otherwise the whole group silently reads (不明)");
  check("the 国籍 column is styled sticky for this table too",
    /#stuGenderTable \.sticky-col/.test(HTML),
    "the rule is scoped per table id; without this the column scrolls away");
}

console.log("\n" + (fail === 0 ? "ALL " + pass + " CHECKS PASSED" : pass + " passed, " + fail + " FAILED"));
process.exitCode = fail === 0 ? 0 : 1;
