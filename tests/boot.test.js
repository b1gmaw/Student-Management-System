// The boot-path optimisation. Four pieces of pure logic that are easy to get
// wrong and impossible to see failing without a browser:
//
//  A. _weekDateStrings_   — the calendar week filter. getAllTeachersSchedule used
//                          to ignore its weekStartDate argument and ship all of
//                          Schedule_DB; now it filters, so an off-by-one or a
//                          timezone slip silently empties someone's calendar.
//  B. week filtering     — the filter must keep exactly the rows it should, and
//                          must degrade to "everything" on a bad argument rather
//                          than to "nothing".
//  C. includePast        — getDashboardData(role) must NOT return Past_DB unless
//                          asked, and must still return it when asked.
//  D. boot gating        — _bootPayload_ must ask for a producer if and only if
//                          the user is entitled to it, matching what the
//                          front-end used to decide client-side.

let pass = 0, fail = 0;
function check(n, c, d) {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + "\n        " + d); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ==================== A. _weekDateStrings_ ====================
// Transcribed from Code.js. Dates are handled as STRINGS end to end because
// Schedule_DB displays them as YYYY-MM-DD and _findScheduleRow_ compares with
// ===. new Date("2026-07-31") would parse as UTC and shift the day for anyone
// east of Greenwich, so components are split and rebuilt by hand.
function _weekDateStrings_(weekStart) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(weekStart || "").trim());
  if (!m) return null;
  const d = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
  if (isNaN(d.getTime())) return null;
  let out = [];
  for (let i = 0; i < 5; i++) {
    const y = d.getFullYear();
    const mo = ('0' + (d.getMonth() + 1)).slice(-2);
    const da = ('0' + d.getDate()).slice(-2);
    out.push(y + '-' + mo + '-' + da);
    d.setDate(d.getDate() + 1);
  }
  return out;
}

console.log("\nA. _weekDateStrings_");
check("plain week",
  eq(_weekDateStrings_("2026-07-27"),
     ["2026-07-27", "2026-07-28", "2026-07-29", "2026-07-30", "2026-07-31"]),
  JSON.stringify(_weekDateStrings_("2026-07-27")));

check("rolls over a month boundary",
  eq(_weekDateStrings_("2026-07-30"),
     ["2026-07-30", "2026-07-31", "2026-08-01", "2026-08-02", "2026-08-03"]),
  JSON.stringify(_weekDateStrings_("2026-07-30")));

check("rolls over a year boundary",
  eq(_weekDateStrings_("2026-12-30"),
     ["2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02", "2027-01-03"]),
  JSON.stringify(_weekDateStrings_("2026-12-30")));

check("handles a leap day",
  eq(_weekDateStrings_("2028-02-28"),
     ["2028-02-28", "2028-02-29", "2028-03-01", "2028-03-02", "2028-03-03"]),
  JSON.stringify(_weekDateStrings_("2028-02-28")));

check("non-leap year has no Feb 29",
  eq(_weekDateStrings_("2026-02-26"),
     ["2026-02-26", "2026-02-27", "2026-02-28", "2026-03-01", "2026-03-02"]),
  JSON.stringify(_weekDateStrings_("2026-02-26")));

// The whole point of the string-arithmetic approach: the first day out must be
// the day that went in, never the day before it.
check("first element is the input, not a UTC-shifted day",
  _weekDateStrings_("2026-07-27")[0] === "2026-07-27",
  _weekDateStrings_("2026-07-27")[0]);

check("always exactly 5 days (Mon-Fri grid)",
  _weekDateStrings_("2026-07-27").length === 5, "wrong length");

[null, undefined, "", "   ", "2026-7-27", "2026/07/27", "not a date", "20260727"]
  .forEach(function (bad) {
    check("rejects " + JSON.stringify(bad), _weekDateStrings_(bad) === null,
      "got " + JSON.stringify(_weekDateStrings_(bad)));
  });

// ==================== B. week filtering ====================
// Mirrors the loop in getAllTeachersSchedule: col 3 is the date, col 1 the
// teacher id.
function filterWeek(rows, weekStart) {
  const week = _weekDateStrings_(weekStart);
  let inWeek = {};
  if (week) week.forEach(function (d) { inWeek[d] = true; });
  let out = [];
  for (let i = 1; i < rows.length; i++) {
    if (week && !inWeek[String(rows[i][3]).trim()]) continue;
    out.push(rows[i]);
  }
  return out;
}

const SCHED = [
  ["Intake", "TeacherId", "TeacherName", "Date", "Period"],
  ["", "T1", "甲野", "2026-07-24", "09:00 ~ 09:30"],   // Friday BEFORE the week
  ["", "T1", "甲野", "2026-07-27", "09:00 ~ 09:30"],   // Monday
  ["", "T2", "乙山", "2026-07-29", "10:00 ~ 10:30"],   // Wednesday
  ["", "T1", "甲野", "2026-07-31", "13:00 ~ 13:30"],   // Friday
  ["", "T2", "乙山", "2026-08-01", "09:00 ~ 09:30"],   // Saturday, outside
  ["", "T1", "甲野", "2026-08-03", "09:00 ~ 09:30"],   // next Monday
  ["", "T1", "甲野", " 2026-07-28 ", "11:00 ~ 11:30"], // padded — must still match
];

console.log("\nB. week filtering");
{
  const got = filterWeek(SCHED, "2026-07-27");
  check("keeps only the requested week", got.length === 4, "kept " + got.length);
  check("keeps Monday",     got.some(r => r[3] === "2026-07-27"), "missing Mon");
  check("keeps Friday",     got.some(r => r[3] === "2026-07-31"), "missing Fri");
  check("drops the prior Friday",  !got.some(r => String(r[3]).trim() === "2026-07-24"), "leaked");
  check("drops the Saturday",      !got.some(r => String(r[3]).trim() === "2026-08-01"), "leaked");
  check("drops the following week",!got.some(r => String(r[3]).trim() === "2026-08-03"), "leaked");
  check("trims whitespace before matching",
    got.some(r => String(r[3]).trim() === "2026-07-28"), "padded date was dropped");
}
{
  // LOAD-BEARING: calLoadData passes "" on purpose to fetch every week at once,
  // so navigation between weeks is client-side and costs no round trip. If this
  // ever returned nothing instead of everything, the calendar would come up
  // blank — which reads as data loss, not as a bug.
  const all = filterWeek(SCHED, "");
  check("empty weekStart returns every row (what calLoadData relies on)",
    all.length === SCHED.length - 1, "got " + all.length);

  // Same contract for the other ways a caller can decline to filter.
  [null, undefined, "garbage"].forEach(function (v) {
    check("weekStart " + JSON.stringify(v) + " also returns every row",
      filterWeek(SCHED, v).length === SCHED.length - 1,
      "got " + filterWeek(SCHED, v).length);
  });
}
{
  const none = filterWeek(SCHED, "2026-09-07");
  check("a week with no bookings is legitimately empty", none.length === 0,
    "got " + none.length);
}

// ==================== C. includePast ====================
function getDashboardData(tabs, includePast) {
  return {
    current: tabs["Central_DB"] || [],
    past: includePast ? (tabs["Past_DB"] || []) : []
  };
}
const TABS = {
  "Central_DB": [["学籍番号", "名前"], ["202507001", "A"], ["202507002", "B"]],
  "Past_DB":    [["学籍番号", "名前"], ["202304001", "C"]]
};

console.log("\nC. includePast");
{
  const boot = getDashboardData(TABS, false);
  check("boot omits Past_DB", boot.past.length === 0, "past leaked " + boot.past.length);
  check("boot still returns Central_DB", boot.current.length === 3, "current " + boot.current.length);

  const full = getDashboardData(TABS, true);
  check("explicit request returns Past_DB", full.past.length === 2, "past " + full.past.length);
  check("explicit request still returns Central_DB", full.current.length === 3, "current " + full.current.length);

  // The front-end guards on `data.past && data.past.length`, so the omitted
  // case must be falsy-length rather than undefined — otherwise _fillPastStudents
  // would latch pastStudentsLoaded on an empty array and the sub-tab would stay
  // permanently blank.
  check("omitted past is an empty array, not undefined",
    Array.isArray(boot.past) && boot.past.length === 0, typeof boot.past);
}

// ==================== D. boot gating ====================
// Mirrors _bootPayload_'s entitlement checks, which reproduce what
// setupInterfaceBasedOnRole used to decide client-side.
function _isAdminRole_(r) { return r === "admin" || r === "master"; }

// Transcribed EXACTLY from Code.js. Note what it does not do: the backend
// treats only the master ROLE as all-access, whereas the front-end's
// hasPermission() also honours a literal permissions === "ALL". That divergence
// predates this change; it is pinned below so the boot bundle's fallback path
// stays deliberate rather than accidental.
function _hasPerm_(role, perms, needed) {
  if (role === "master") return true;
  if (!perms) return false;
  let list = Array.isArray(perms) ? perms : String(perms).split(",").map(s => s.trim());
  return list.indexOf(needed) !== -1;
}
function gating(role, perms) {
  return {
    dash: _hasPerm_(role, perms, "view_students") ||
          _hasPerm_(role, perms, "view_admissions") ||
          _hasPerm_(role, perms, "view_dorms"),
    notif: _isAdminRole_(role) || role === "sales" || role === "teacher"
  };
}

console.log("\nD. boot gating");
{
  const m = gating("master", "ALL");
  check("master gets dashboard",     m.dash === true, JSON.stringify(m));
  check("master gets notifications", m.notif === true, JSON.stringify(m));

  const t = gating("teacher", "view_teacher_schedule");
  check("teacher gets notifications", t.notif === true, JSON.stringify(t));
  check("teacher with no student perms gets NO dashboard", t.dash === false,
    "would have fetched 141KB of Central_DB for someone who cannot view it");

  const s = gating("sales", "view_students,view_dorms");
  check("sales gets both", s.dash === true && s.notif === true, JSON.stringify(s));

  // A staff account whose only permission is 申請: no dashboard, and no bell.
  const x = gating("staff", "view_shinsei");
  check("shinsei-only user gets neither", x.dash === false && x.notif === false,
    JSON.stringify(x));

  // Any ONE of the three permissions is enough — this is an OR, and turning it
  // into an AND would silently blank the student table for dorm-only users.
  check("view_dorms alone is enough for the dashboard",
    gating("staff", "view_dorms").dash === true, "dorm-only user got no dashboard");
  check("view_admissions alone is enough for the dashboard",
    gating("staff", "view_admissions").dash === true, "admissions-only user got no dashboard");

  // A non-master account with a literal "ALL" in its permissions cell is judged
  // differently by the two sides: the backend does not expand it, so the bundle
  // arrives WITHOUT a dashboard, while the front-end's hasPermission() says the
  // user may see one. This is precisely why setupInterfaceBasedOnRole falls back
  // to a direct getDashboardData call instead of assuming boot.dashboard is
  // present — the user still gets their data, just at the old cost.
  check("literal ALL perms is not expanded by the backend (front-end differs)",
    gating("admin", "ALL").dash === false,
    "backend now expands ALL — the front-end fallback assumption needs revisiting");
  check("...and the fallback path is what covers that user",
    gating("admin", "ALL").notif === true,
    "admin should still get notifications, which are role-gated not perm-gated");

  // Permission lists are stored with spaces after the commas in some rows.
  check("permissions are trimmed before matching",
    gating("staff", "view_dorms, view_students").dash === true,
    "a space after the comma broke the match");
}

console.log("\n" + (fail === 0 ? "ALL " + pass + " CHECKS PASSED" : pass + " passed, " + fail + " FAILED"));
process.exitCode = fail === 0 ? 0 : 1;
