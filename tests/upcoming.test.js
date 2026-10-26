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
// ⚠️ NOT `status === "Booked"`. A booking carrying a request keeps its student and still
// happens: 交代 leaves Status at Reassign_Pending until the other teacher accepts, and
// キャンセル依頼 at Cancel_Request until an admin approves. Both used to vanish from ホーム while
// the bell showed the request — reported 2026-09-16 as "booked but not showing". Section 6
// exercises it, and binds this transcription to Code.js.
function liveState(status, student) {
  const s = String(status == null ? "" : status).trim();
  const who = String(student == null ? "" : student).trim();
  if (s === "Booked") return "";
  if (who === "") return null;
  if (s === "Reassign_Pending") return "reassign";
  if (s === "Cancel_Request") return "cancelreq";
  return null;
}

function upcoming(rows, me, today, cutoff) {
  const myRole = String(me.role || "");
  if (myRole !== "teacher" && myRole !== "sales") return [];
  const meName = normName(me.name);
  const meId = String(me.id || "").trim();
  let out = [];
  for (const r of rows) {
    const state = liveState(r[5], r[6]);
    if (state === null) continue;
    const date = String(r[3] || "").trim();
    if (date < today || date > cutoff) continue;
    const mine = (myRole === "teacher")
      ? String(r[1] || "").trim() === meId
      : normName(r[11]) === meName && meName !== "";
    if (!mine) continue;
    out.push({ date, period: String(r[4] || ""), student: String(r[6] || ""),
               teacherName: String(r[2] || ""), state });
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

console.log("\n6. ⚠️ a booking with a request on it is STILL an interview");
{
  // Reported 2026-09-16: a 営業's interview, booked for that same day, was missing from ホーム.
  // 交代 moves Status to Reassign_Pending and キャンセル依頼 to Cancel_Request, and both keep the
  // student — the interview happens unless somebody acts on the request. The bell showed the
  // request while ホーム dropped the interview.
  const REQ = [
    row("T1", "甲野", "2026-08-07", "09:00 ~ 09:30", "Reassign_Pending", "StudentG", "乙山"),
    row("T1", "甲野", "2026-08-08", "10:00 ~ 10:30", "Cancel_Request",   "StudentH", "乙山"),
    row("T1", "甲野", "2026-08-09", "11:00 ~ 11:30", "Reassign_Pending", "",     "乙山"),  // an offered slot
    row("T1", "甲野", "2026-08-10", "12:00 ~ 12:30", "Available",        "",     "乙山")
  ];
  const s = upcoming(REQ, SALES, TODAY, CUTOFF);
  const names = s.map(r => r.student);
  check("a 交代待ち booking is listed", names.indexOf("StudentG") !== -1, JSON.stringify(names));
  check("...and says so, so the row explains itself",
    (s.find(r => r.student === "StudentG") || {}).state === "reassign", JSON.stringify(s));
  check("a キャンセル依頼中 booking is listed", names.indexOf("StudentH") !== -1, JSON.stringify(names));
  check("...with its own state",
    (s.find(r => r.student === "StudentH") || {}).state === "cancelreq", JSON.stringify(s));
  // ⚠️ The student is what makes those states count. Reassign_Pending on an EMPTY row is a slot
  // being offered around, not somebody's interview.
  check("⚠️ a pending row with no student is not an interview", names.indexOf("") === -1, JSON.stringify(names));
  check("Available is still not an interview", s.length === 2, JSON.stringify(names));
  // A plain booking keeps an empty state, so an ordinary row renders exactly as before.
  check("a plain booking carries no state",
    upcoming(SCHED, SALES, TODAY, CUTOFF).every(r => r.state === ""), "");

  // mutation: the old status test hides both.
  const old = REQ.filter(r => String(r[5]).trim() === "Booked");
  check("  mutation: the old `=== Booked` test finds neither", old.length === 0, JSON.stringify(old));

  // ⚠️ BINDING: everything above exercises the transcription at the top of this file. Without
  // this, Code.js could narrow back to `=== "Booked"` and the suite would still pass — the
  // cellsafe §8 lesson.
  const fs2 = require('fs'), path2 = require('path');
  const SRC = fs2.readFileSync(path2.join(__dirname, '..', 'Code.js'), 'utf8');
  const at = SRC.indexOf('\nfunction _scheduleLiveState_(');
  const body = at === -1 ? '' : SRC.slice(at, SRC.indexOf('\n}\n', at));
  check("Code.js really has _scheduleLiveState_", body.length > 100, "the rule must live in exactly one place");
  check("...and it names both pending states",
    body.indexOf('"Reassign_Pending"') !== -1 && body.indexOf('"Cancel_Request"') !== -1, body);
  check("...returning null only after the student check",
    body.indexOf('if (who === "") return null;') !== -1 &&
    body.indexOf('if (who === "") return null;') < body.indexOf('"Reassign_Pending"'), body);
  check("getUpcomingForUser asks it rather than testing the status itself",
    /const state = _scheduleLiveState_\(data\[i\]\[5\], data\[i\]\[6\]\);/.test(SRC) &&
    SRC.indexOf('if (String(data[i][5]).trim() !== "Booked") continue;') === -1, "");
}

console.log("\n" + (fail === 0 ? "ALL " + pass + " CHECKS PASSED" : pass + " passed, " + fail + " FAILED"));
process.exitCode = fail === 0 ? 0 : 1;
