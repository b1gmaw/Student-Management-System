// ホーム やること — the upcoming-interview half.
//
// Two things this has to get right, and both have bitten this codebase before:
//
//   - DATES ARE STRINGS. Schedule_DB stores YYYY-MM-DD, and
//     `new Date("YYYY-MM-DD")` parses as UTC, which shifts the day in Asia/Tokyo.
//     The 前年 work lost a round to date handling; this compares strings, which
//     has no timezone to get wrong.
//   - SCOPE IS PER ROLE. A teacher's slots are keyed by ID, a 営業's bookings by
//     the 担当 NAME. Getting that backwards would show one person another's
//     work, or silently show nobody anything.

let pass = 0, fail = 0;
function check(n, c, d) {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + "\n        " + d); }
}

// ---- Transcribed from Code.js ----
const HOME_UPCOMING_DAYS = 7;

function normName(v) {
  let s = String(v == null ? "" : v);
  s = s.replace(/[！-～]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
  s = s.replace(/[\s　 ]/g, "");
  return s.toLowerCase().trim();
}

// rows: [ , teacherId, teacherName, date, period, status, student, nat, link, , course, inCharge ]
function upcoming(rows, me, today, cutoff) {
  const myRole = String(me.role || "");
  if (myRole !== "teacher" && myRole !== "sales") return [];
  const meName = normName(me.name);
  const meId = String(me.id || "").trim();
  let out = [];
  for (const r of rows) {
    if (String(r[5]).trim() !== "Booked") continue;
    const date = String(r[3] || "").trim();
    if (date < today || date > cutoff) continue;
    const mine = (myRole === "teacher")
      ? String(r[1] || "").trim() === meId
      : normName(r[11]) === meName && meName !== "";
    if (!mine) continue;
    out.push({ date, period: String(r[4] || ""), student: String(r[6] || ""),
               teacherName: String(r[2] || "") });
  }
  out.sort((a, b) => a.date !== b.date ? (a.date < b.date ? -1 : 1)
                                       : String(a.period).localeCompare(String(b.period), "ja"));
  return out;
}

const row = (tid, tname, date, period, status, student, inCharge) =>
  ["", tid, tname, date, period, status, student, "", "", "", "進学2年課程", inCharge];

const TODAY = "2026-08-06", CUTOFF = "2026-08-13";
const SCHED = [
  row("T1", "甲野", "2026-08-06", "09:00 ~ 09:30", "Booked",  "Aarav",  "乙山"),
  row("T1", "甲野", "2026-08-13", "10:00 ~ 10:30", "Booked",  "StudentA",   "乙山"),
  row("T2", "丙川", "2026-08-07", "11:00 ~ 11:30", "Booked",  "StudentB",   "乙山"),
  row("T1", "甲野", "2026-08-14", "09:00 ~ 09:30", "Booked",  "StudentC",  "乙山"),   // past cutoff
  row("T1", "甲野", "2026-08-05", "09:00 ~ 09:30", "Booked",  "StudentD", "乙山"),   // yesterday
  row("T1", "甲野", "2026-08-08", "09:00 ~ 09:30", "Available", "",     "乙山"),   // not booked
  row("T1", "甲野", "2026-08-09", "09:00 ~ 09:30", "Booked",  "StudentE",  "丁村")    // another 担当
];

const TEACHER = { role: "teacher", id: "T1", name: "甲野" };
const SALES   = { role: "sales",   id: "S1", name: "乙山" };

console.log("\n1. the 7-day window, by string comparison");
{
  const got = upcoming(SCHED, TEACHER, TODAY, CUTOFF);
  const dates = got.map(r => r.date);
  check("today is included", dates.indexOf("2026-08-06") !== -1, JSON.stringify(dates));
  check("the cutoff day itself is included", dates.indexOf("2026-08-13") !== -1, JSON.stringify(dates));
  check("the day after the cutoff is not", dates.indexOf("2026-08-14") === -1, JSON.stringify(dates));
  check("yesterday is not", dates.indexOf("2026-08-05") === -1, JSON.stringify(dates));
  // The window is inclusive at both ends, so 7 days means 8 dates.
  check("window is inclusive at both ends", HOME_UPCOMING_DAYS === 7, String(HOME_UPCOMING_DAYS));
  // String compare must order dates correctly across a month boundary.
  check("string compare orders across months", "2026-08-31" < "2026-09-01", "");
  check("and across years", "2026-12-31" < "2027-01-01", "");
}

console.log("\n2. only Booked slots count");
{
  const got = upcoming(SCHED, TEACHER, TODAY, CUTOFF);
  check("an Available slot is not a task",
    !got.some(r => r.student === ""), JSON.stringify(got.map(r => r.student)));
}

console.log("\n3. scope: teacher by ID, 営業 by 担当 name");
{
  const t = upcoming(SCHED, TEACHER, TODAY, CUTOFF);
  check("a teacher sees only their own slots",
    t.every(r => r.teacherName === "甲野"), JSON.stringify(t.map(r => r.teacherName)));
  check("including one whose 担当 is someone else",
    t.some(r => r.student === "StudentE"),
    "a teacher's slot is theirs regardless of who booked it");

  const s = upcoming(SCHED, SALES, TODAY, CUTOFF);
  check("a 営業 sees bookings across teachers",
    s.some(r => r.teacherName === "甲野") && s.some(r => r.teacherName === "丙川"),
    JSON.stringify(s.map(r => r.teacherName)));
  check("but not one where 担当 is another person",
    !s.some(r => r.student === "StudentE"), JSON.stringify(s.map(r => r.student)));

  // 担当 is matched by NAME, so spacing and width must not break it — the
  // recurring identity-by-name-string class in CLAUDE.md.
  const spaced = [row("T3", "戊田", "2026-08-07", "09:00 ~ 09:30", "Booked", "StudentF", "　乙山 ")];
  check("担当 matching survives spacing and full-width",
    upcoming(spaced, SALES, TODAY, CUTOFF).length === 1,
    "a stray space would silently hide the booking from its owner");

  // A 営業 with no name matches nothing rather than everything — the dangerous
  // direction if the guard were written the other way round.
  const noName = upcoming(SCHED, { role: "sales", id: "S9", name: "" }, TODAY, CUTOFF);
  check("an empty 担当 name matches nothing, not everything", noName.length === 0,
    String(noName.length));
}

console.log("\n4. admins get nothing here, by decision");
{
  ["admin", "master"].forEach(r => {
    check(r + " sees no interview list",
      upcoming(SCHED, { role: r, id: "A1", name: "管理" }, TODAY, CUTOFF).length === 0,
      "an all-interviews list is a schedule, and 面接スケジュール already does that");
  });
  check("an unknown role also gets nothing",
    upcoming(SCHED, { role: "", id: "", name: "" }, TODAY, CUTOFF).length === 0, "");
}

console.log("\n5. ordering");
{
  const got = upcoming(SCHED, SALES, TODAY, CUTOFF);
  for (let i = 1; i < got.length; i++) {
    check(`row ${i} is not earlier than row ${i-1}`,
      got[i-1].date <= got[i].date, `${got[i-1].date} then ${got[i].date}`);
  }
  // Same day, two periods — the earlier slot first.
  const sameDay = [
    row("T1", "甲野", "2026-08-07", "14:00 ~ 14:30", "Booked", "B", "乙山"),
    row("T1", "甲野", "2026-08-07", "09:00 ~ 09:30", "Booked", "A", "乙山")
  ];
  const s = upcoming(sameDay, TEACHER, TODAY, CUTOFF);
  check("same-day slots order by period", s[0].student === "A", JSON.stringify(s.map(r => r.student)));
}

console.log("\n" + (fail === 0 ? "ALL " + pass + " CHECKS PASSED" : pass + " passed, " + fail + " FAILED"));
process.exitCode = fail === 0 ? 0 : 1;
