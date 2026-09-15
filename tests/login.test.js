// Failed-login delay, transcribed from Code.js loginUser.
//
// Two things must hold: failures get slower, and the delay is CAPPED so a
// sustained attack cannot turn the defence itself into a staff-facing outage.
// The final section states the honest limit — the delay does NOT make a 4-digit
// PIN safe, and says so numerically so nobody mistakes it for a fix.

const LOGIN_FAIL_DELAY_MS = 1500;
const LOGIN_FAIL_WINDOW = 300;
const LOGIN_FAIL_ESCALATE_AT = 8;
const LOGIN_FAIL_MAX_DELAY_MS = 8000;

let cache = {}, clock = 0;
const cachePut = (k, v, ttl) => { cache[k] = { v, exp: clock + ttl }; };
function cacheGet(k) {
  const e = cache[k];
  if (!e) return null;
  if (clock >= e.exp) { delete cache[k]; return null; }
  return e.v;
}
function _noteLoginFailure_() {
  const n = (parseInt(cacheGet('loginFails') || '0', 10) || 0) + 1;
  cachePut('loginFails', String(n), LOGIN_FAIL_WINDOW);
  return n;
}
function delayFor(n) {
  let wait = LOGIN_FAIL_DELAY_MS;
  if (n > LOGIN_FAIL_ESCALATE_AT) {
    wait = Math.min(LOGIN_FAIL_DELAY_MS * (1 + (n - LOGIN_FAIL_ESCALATE_AT)), LOGIN_FAIL_MAX_DELAY_MS);
  }
  return wait;
}

let pass = 0, fail = 0;
function check(n, c, d) {
  if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + "\n        " + d); }
}
const reset = () => { cache = {}; clock = 0; };

console.log("\n1. A single mistyped PIN costs one base delay");
{
  reset();
  check("first failure is 1500ms", delayFor(_noteLoginFailure_()) === 1500, String(delayFor(1)));
}

console.log("\n2. Flat until the threshold, then escalates");
{
  reset();
  const seen = [];
  for (let i = 0; i < 14; i++) seen.push(delayFor(_noteLoginFailure_()));
  check("first 8 flat at 1500ms", seen.slice(0, 8).every(x => x === 1500), JSON.stringify(seen.slice(0, 8)));
  check("then grows", seen[8] > 1500 && seen[9] > seen[8], JSON.stringify(seen.slice(8, 11)));
  console.log("        delays: " + seen.join(", "));
}

console.log("\n3. CAPPED — the defence cannot become the outage");
{
  reset();
  let worst = 0;
  for (let i = 0; i < 5000; i++) worst = Math.max(worst, delayFor(_noteLoginFailure_()));
  check("never exceeds the cap", worst === LOGIN_FAIL_MAX_DELAY_MS, "worst=" + worst);
}

console.log("\n4. Counter expires, so staff aren't punished for yesterday");
{
  reset();
  for (let i = 0; i < 20; i++) _noteLoginFailure_();
  const during = delayFor(parseInt(cacheGet('loginFails'), 10));
  clock += LOGIN_FAIL_WINDOW + 1;
  check("escalated during the window", during > 1500, String(during));
  check("back to base after it lapses", delayFor(_noteLoginFailure_()) === 1500, "still escalated");
}

console.log("\n5. Honest limit — this is defence in depth, NOT a fix");
{
  const PARALLEL = 30;                                    // GAS simultaneous-execution ceiling
  const hours = (combos, delayMs) => (combos * (delayMs / 1000)) / PARALLEL / 3600;
  const days = (c, d) => hours(c, d) / 24;
  const years = (c, d) => days(c, d) / 365;
  console.log("        4-digit  @ 8s: " + hours(1e4, 8000).toFixed(1) + " h   <- why the minimum is 8");
  console.log("        6-digit  @ 8s: " + days(1e6, 8000).toFixed(1) + " days");
  console.log("        8-digit  @ 8s: " + days(1e8, 8000).toFixed(0) + " days");
  console.log("        8-char a-zA-Z0-9 @ 8s: " + years(Math.pow(62, 8), 8000).toExponential(1) + " years");
  check("4-digit falls in well under a day even at the cap", hours(1e4, 8000) < 1,
    "would be " + hours(1e4, 8000).toFixed(1) + "h");
  check("6-digit buys days, not years", days(1e6, 8000) > 2 && days(1e6, 8000) < 10,
    days(1e6, 8000).toFixed(1) + " days");
  check("8-digit buys roughly a year, not eight", days(1e8, 8000) > 250 && days(1e8, 8000) < 400,
    days(1e8, 8000).toFixed(0) + " days");
  // Why setSystemPin warns when the value is numeric-only: at the same length,
  // the alphabet matters far more than the delay ever will.
  check("8-char alphanumeric is out of reach of online guessing",
    years(Math.pow(62, 8), 8000) > 1e5, years(Math.pow(62, 8), 8000).toExponential(1) + " years");
}

console.log("\n6. setSystemPin validation");
{
  // Transcribed from Code.js setSystemPin. Staff PINs here include a long one,
  // because a 4-digit staff PIN can never collide with an 8-character minimum —
  // the collision rule only bites once somebody's own PIN is long too.
  const SYSTEM_PIN_MIN_LENGTH = 8;
  const STAFF_PINS = ["1234", "4321", "sakura2026"];

  function validate(newPin) {
    const v = String(newPin == null ? "" : newPin).trim();
    if (v.length < SYSTEM_PIN_MIN_LENGTH) return "too-short";
    if (STAFF_PINS.indexOf(v) !== -1) return "collision";
    return "ok";
  }

  check("minimum length is 8", SYSTEM_PIN_MIN_LENGTH === 8, String(SYSTEM_PIN_MIN_LENGTH));
  check("rejects a 4-digit PIN", validate("4242") === "too-short", validate("4242"));
  check("rejects empty", validate("") === "too-short", validate(""));
  check("rejects null", validate(null) === "too-short", validate(null));
  check("rejects undefined", validate(undefined) === "too-short", validate(undefined));
  check("rejects 7 characters", validate("1234567") === "too-short", validate("1234567"));
  check("accepts exactly 8", validate("12345678") === "ok", validate("12345678"));
  check("whitespace is trimmed before the length test",
    validate("  abc   ") === "too-short", validate("  abc   "));
  check("accepts a normal long value", validate("Sample-2026") === "ok", validate("Sample-2026"));

  // The one that matters. _resolveUserByPin tests the master PIN FIRST and
  // returns immediately, so a master PIN equal to somebody's staff PIN would
  // hand that person master access — and they would never reach their own row,
  // so nothing would look wrong from their side either.
  check("rejects a value matching an existing staff PIN",
    validate("sakura2026") === "collision", validate("sakura2026"));
  check("a value merely similar to a staff PIN is fine",
    validate("sakura2027") === "ok", validate("sakura2027"));
  check("the collision test runs after the length test",
    validate("1234") === "too-short",
    "a short staff PIN should be rejected for length, not reported as a collision");
}

// ---------------------------------------------------------------------------
console.log("\n7. Sessions expire — transcribed from Code.js _sessionExpired_");
{
  // Tokens used to live forever: nothing ever read the LastSeen column that had
  // been written for months, so a token in localStorage on a shared machine was
  // a permanent credential.
  const SESSION_MAX_AGE_DAYS = 30;
  const SESSION_MAX_AGE_MS = SESSION_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

  function _sessionAgeMs_(lastSeen, now) {
    const s = String(lastSeen == null ? "" : lastSeen).trim();
    if (s === "") return -1;
    const m = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (!m) return -1;
    const t = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)).getTime();
    if (isNaN(t)) return -1;
    return now - t;
  }
  function _sessionExpired_(lastSeen, now) {
    const age = _sessionAgeMs_(lastSeen, now);
    return age >= 0 && age > SESSION_MAX_AGE_MS;
  }

  const NOW = new Date(2026, 7, 19, 12, 0, 0).getTime();   // 2026-08-19 12:00
  const daysAgo = function (d) {
    const t = new Date(NOW - d * 24 * 60 * 60 * 1000);
    const p = function (n) { return (n < 10 ? "0" : "") + n; };
    return t.getFullYear() + "/" + p(t.getMonth() + 1) + "/" + p(t.getDate()) +
           " " + p(t.getHours()) + ":" + p(t.getMinutes()) + ":" + p(t.getSeconds());
  };

  check("a session used today is valid", !_sessionExpired_(daysAgo(0), NOW), "");
  check("29 days idle is still valid", !_sessionExpired_(daysAgo(29), NOW), daysAgo(29));
  check("31 days idle is expired", _sessionExpired_(daysAgo(31), NOW), daysAgo(31));
  check("a year idle is expired", _sessionExpired_(daysAgo(365), NOW), "");

  // ⚠️ The boundary itself. Off-by-one here is the difference between "expires
  // after a month" and "expires a day early for everyone", and nobody would
  // notice the second one except as mysterious logouts.
  check("exactly 30 days is NOT yet expired",
    !_sessionExpired_(daysAgo(30), NOW),
    "the comparison must be > MAX_AGE, not >=");

  // ⚠️ Both must FAIL OPEN. Signing out every member of staff at once because a
  // date printed in an unexpected shape is far worse than one stale token
  // outliving its window, and the failure would be invisible from the inside.
  check("a blank LastSeen is not treated as expired",
    !_sessionExpired_("", NOW),
    "rows predating the column would log those people out with no explanation");
  check("an unparseable LastSeen is not treated as expired",
    !_sessionExpired_("last tuesday", NOW) && !_sessionExpired_("19/08/2026", NOW),
    "fail open — an unanticipated locale format must not become a mass logout");

  // FORMATTED_STRING renders per the spreadsheet's locale, so the parser takes
  // both separators and tolerates a missing time.
  check("ISO-style separators parse too", _sessionExpired_("2020-01-01 09:00:00", NOW), "");
  check("a date with no time parses", _sessionExpired_("2020/01/01", NOW), "");

  // The renewal is sliding, and SESSION_TOUCH_WINDOW is its granularity.
  const SESSION_TOUCH_WINDOW = 21600;   // 6h, from Code.js
  check("the touch window is far inside the expiry window",
    SESSION_TOUCH_WINDOW * 1000 * 4 < SESSION_MAX_AGE_MS,
    "LastSeen is only rewritten once per touch window, so bringing the two " +
    "close together logs out users who are actively working");

  // Source assertions — the transcription above is worthless if the real code
  // stopped calling it, which is exactly how a guard goes quietly dead.
  const fs2 = require('fs');
  const CODE = fs2.readFileSync(require('path').join(__dirname, '..', 'Code.js'), 'utf8');

  // ⚠️ Scoped to resumeSession's OWN body. Written against the whole file these
  // matched _pruneExpiredSessions instead — which also calls _sessionExpired_ on
  // data[i][5] — so they stayed green with the check ripped out of resumeSession
  // entirely. Caught by mutation; the same "assertion measures the wrong thing"
  // failure the uploadedfile suite hit.
  // ⚠️ RE-PINNED 2026-09-11: the decision moved into _sessionLookup_(token, touch), which
  // resumeSession wraps and checkSession shares. Every property below is asserted where the
  // decision now lives — and that resumeSession still reaches it WITH the touch.
  check("resumeSession is the touching wrapper around the one decision",
    /function resumeSession\(token\) \{\s*return _sessionLookup_\(token, true\);\s*\}/.test(CODE), "");
  const rsAt = CODE.indexOf('function _sessionLookup_(');
  const RS = CODE.slice(rsAt, CODE.indexOf('\n}', rsAt));
  check("resumeSession's body was located", rsAt !== -1 && RS.length > 200,
    "the anchor moved — every assertion below is meaningless until this passes");
  // ⚠️ RE-PINNED 2026-09-11: judged by _sessionSeenOf_ (LastSeen, else Created), and deleted by
  // TOKEN under the lock — a remembered row number goes stale the moment another request deletes.
  check("resumeSession actually checks expiry",
    /_sessionExpired_\(_sessionSeenOf_\(data\[i\]\), Date\.now\(\)\)/.test(RS),
    "the helper exists but resumeSession does not call it");
  check("the expiry check runs BEFORE _authUser is parked",
    RS.indexOf('_sessionExpired_(_sessionSeenOf_(data[i])') !== -1 &&
    RS.indexOf('_sessionExpired_(_sessionSeenOf_(data[i])') < RS.indexOf('_authUser = user;'),
    "parking an expired session makes it live for every guard in the file");
  check("expired rows are deleted, not just refused — by token",
    /_sessionExpired_\(_sessionSeenOf_\(data\[i\]\)[\s\S]{0,200}?_deleteSessionByToken_\(token\)/.test(RS), "");
  // ⚠️ RE-PINNED 2026-09-11: the per-row prune became ONE-PASS compaction (_compactSessions_),
  // which also normalises dates and applies the per-account cap. It never ran at all before:
  // month-first dates made every row "unreadable", i.e. current.
  const IS = CODE.slice(CODE.indexOf('function _issueSessionToken_('), CODE.indexOf('\n}', CODE.indexOf('function _issueSessionToken_(')));
  check("login compacts sessions, under the lock, AFTER appending its own row",
    /_withSessionLock_\(10000, function \(\) \{\s*sh\.appendRow\([\s\S]{0,120}\);\s*_compactSessions_\(sh, Date\.now\(\)\);/.test(IS),
    "without this the Sessions sheet still grows without bound");

  // ⚠️ The prune runs inside _issueSessionToken_, on loginUser's critical path,
  // and Sessions had never been pruned before — so the first login after this
  // shipped met the whole backlog, one Sheets call per row. Unbounded, that is a
  // login that hangs and then times out, and an execution timeout is not
  // catchable. The transcription above cannot see an unbounded loop; only this
  // source assertion can.
  // The login-path stall this section guarded against is now impossible by construction: the
  // compaction is one read and at most two writes, however large the backlog, and never a
  // deleteRow per row.
  // Comments stripped: the function's own comment explains WHY it avoids deleteRow.
  const CS = CODE.slice(CODE.indexOf('function _compactSessions_('), CODE.indexOf('\n}', CODE.indexOf('function _compactSessions_(')))
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  check("compaction never deletes row by row (the stall the old cap bounded)",
    CS.length > 200 && !/deleteRow/.test(CS) && (CS.match(/\.getValues\(\)/g) || []).length === 1,
    "a deleteRow per expired row on the login path can time out the execution");
  check("SESSION_MAX_AGE_DAYS is still " + SESSION_MAX_AGE_DAYS,
    new RegExp("const SESSION_MAX_AGE_DAYS = " + SESSION_MAX_AGE_DAYS + ";").test(CODE),
    "the transcription above is pinned to this number");
}

console.log("\n" + (fail === 0 ? "ALL " + pass + " CHECKS PASSED" : pass + " passed, " + fail + " FAILED"));
process.exitCode = fail === 0 ? 0 : 1;
