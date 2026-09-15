# Student Management System (学生管理システム)

A Google Apps Script web app for running a Japanese language school: interview scheduling,
dorm management, interview results, placement tests, student records, recruitment tracking
and application paperwork (申請). The interface is bilingual (Japanese / English), and the
whole thing runs on Google Workspace: Google Sheets is the database, Google Drive holds
uploaded files, and the frontend is a single HTML page served by Apps Script.

It was built for one school and is used there daily by its staff, so some parts follow how
that school works: course names, the layout of the student-records spreadsheet it imports
from, and the 申請 document forms. Expect to adapt those.

## Features

- **面接スケジュール** — a weekly calendar of interview slots per teacher, with booking,
  date-change and hand-over requests, email notifications, and a one-teacher view on phones.
- **面接結果 / プレースメントテスト** — interview results entry and placement-test results
  pulled from linked result sheets.
- **学生一覧** — current and former students, headcount and enrollment history, export to
  CSV / Excel / PDF.
- **寮管理** — buildings and rooms, nightly auto-assignment from student records, printable
  room sheets and move-in schedules in the student's language.
- **募集状況** — recruitment figures per intake and country, capacity, cancellations and
  a simulation.
- **申請関連** — application documents per student, previewed and exported as PDF.
- **ユーザー管理** — accounts, custom roles with per-screen permissions, announcements,
  an activity log and restorable backups.

## How it is built

| Path | Role |
|---|---|
| `Code.js` | The server: every endpoint, sessions, sheet reads and writes |
| `Index.html` | The **entire** frontend — markup, CSS and JS. It has two `<script>` blocks; the app code is the **second** |
| `Template.html` | Dorm room PDF template |
| `Shinsei_Code.js`, `Shinsei_Template.html` | The 申請 module and its A4 document template |
| `tests/` | Plain Node test suites (see below) |
| `.claude/skills/run-local/` | A Playwright driver that renders the frontend locally |
| `TECHNICAL_REFERENCE.md` | Architecture, data model and the reasoning behind the tricky parts |

- **One door from the browser.** The page calls `apiCall(token, method, args)`, which resumes
  the session and dispatches through an explicit allow-list (`_apiMethods_`).
- **Private server functions end in `_`.** Apps Script hides a function from
  `google.script.run` only when its name ends in an underscore. Every other function is
  callable from any browser that has the URL, so each one checks the session or is on an
  explicit list; `tests/endpoints.test.js` enforces this.
- **No real identifiers in the source.** Drive folder and spreadsheet IDs live in script
  properties (below).

For more depth, `TECHNICAL_REFERENCE.md` covers the architecture (§1–2), roles and permissions
(§3), the data model (§4), login and sessions (§6.1), error codes (§6.4.9), performance (§8) and
recurring bug classes (§9). Code comments that cite `CLAUDE.md` refer to the maintainer's private
working notes, which are not published; the tests enforce the rules those comments describe.

## Setting up your own copy

You need a Google account, a current Node.js LTS, and [clasp](https://github.com/google/clasp).

### 1. Create the project and push the code

1. Create a Google Sheet, then open **Extensions → Apps Script**. The app works on the
   spreadsheet its script is bound to.
2. In the Apps Script editor, copy the **Script ID** from ⚙ Project Settings.
3. Clone this repository, install clasp and sign in:

   ```bash
   git clone https://github.com/b1gmaw/Student-Management-System.git
   cd Student-Management-System
   npm install -g @google/clasp
   clasp login
   ```

4. Create `.clasp.json` in the repository root (it is git-ignored):

   ```json
   {
     "scriptId": "YOUR_SCRIPT_ID",
     "rootDir": "",
     "scriptExtensions": [".js"],
     "htmlExtensions": [".html"],
     "jsonExtensions": [".json"],
     "filePushOrder": [],
     "skipSubdirectories": false
   }
   ```

5. Run `clasp push`. `.claspignore` keeps `tests/` and `.claude/` out of the project.

### 2. Create the sheets the app does not create itself

Most sheets are created the first time they are needed. These five must exist first, with
their header rows: `Staff_Master` and `Teacher_Master` (accounts), `Building_Info` and
`Room_Info` (dorms), and `Shinsei_Data` (申請). Their columns are described in
`TECHNICAL_REFERENCE.md` §3–§4. Never rename a tab or a column header: the code finds them by
name.

### 3. Set the script properties

In ⚙ Project Settings → Script Properties:

| Property | Required | What it is |
|---|---|---|
| `AUTH_ENFORCE` | yes | Set to `1`. Any other value is observe mode, which only logs what the session would have refused |
| `SYSTEM_PIN` | yes | The password of the built-in master account, 8 characters or more. Unset, master cannot sign in |
| `PHOTO_FOLDER_ID` | yes | Drive folder for building photos |
| `UPLOADS_FOLDER_ID` | yes | Drive folder for uploaded files (interview hearing sheets, building documents) |
| `STUDENT_SOURCE_SPREADSHEET_ID` | yes | The spreadsheet the student list is imported from |
| `NOTIFY_FROM_EMAIL` | no | A Gmail alias to send notifications from. Unset, they come from the deploying account |
| `FAVICON_DRIVE_FILE_ID` | no | A Drive image, shared "anyone with the link", used as the tab icon |
| `MAINTENANCE_UNLOCK` | only when needed | Today's date in Asia/Tokyo (`yyyy-MM-dd`). Unlocks the editor-only maintenance functions until midnight |

A missing required property shows staff 「システムの設定が完了していません。（SYS-06）」 and names the
key in the execution log. To check them all at once, set `MAINTENANCE_UNLOCK` and run
`authoriseServices` from the editor: it opens every folder and spreadsheet and reports each one.

⚠️ Script properties do not survive **File → Make a copy**. Every copy needs its own.

### 4. Deploy and sign in

1. **Deploy → New deployment → Web app.** Execute as **you**, access **Anyone**: the app has its
   own sign-in, and `appsscript.json` already declares both settings.
2. Open the web app URL and sign in with the ID `MASTER` and your `SYSTEM_PIN`.
3. Create staff accounts in **ユーザー管理**. Each new account gets a temporary password on save.

⚠️ **`clasp push` uploads files but does not change what the web app serves.** The deployment
stays on its version until you move it:

```bash
clasp push
clasp version "what changed"
clasp deploy -i <deployment-id> -V <version> -d "what changed"
clasp deployments        # read the version number back
```

Repoint the existing deployment (`-i`); a new deployment gets a new URL.

### 5. Scheduled jobs (optional)

Add these as time-driven triggers by hand in the editor (Triggers → Add Trigger):

- `triggerAutoSyncStudents`, daily: imports student records and re-runs the dorm
  auto-assignment.
- `triggerScheduledBackup`, a few times a day: copies every sheet that changed since its last run.

### A staging copy

Keep a second spreadsheet and Apps Script project for testing, with its own
`.clasp-staging.json` and script properties, and push to it with
`clasp -P .clasp-staging.json push`. A bare `clasp push` always goes to the project in
`.clasp.json`, with no confirmation.

## Tests

```bash
./tests/run-all.sh
```

Plain Node, no framework and no dependencies. Each suite either runs the real functions in a
`vm` sandbox with Apps Script services stubbed, or asserts on the source itself (every
`getElementById` resolves, every endpoint is guarded, nothing unescaped reaches `innerHTML`).
Most guards are also run against the old, broken shape of the code, which must fail. The suites
are excluded from `clasp push`.

## Local preview

The frontend can be rendered and screenshotted locally with stubbed server data:

```bash
cd .claude/skills/run-local
npm install && npx playwright install chromium
node driver.mjs shot --vp desktop --tab dorms
```

## Security

- Staff sign in with an email and a salted, hashed password. Sessions are held on the server,
  expire after 30 days idle, and are capped per account.
- Every permission is decided from the session on the server, never from what the browser sends.
- Free text written to sheets is neutralised so it cannot run as a formula.

If you find a security problem, please contact the maintainer through GitHub rather than
opening a public issue.

## License

Copyright (C) 2026 b1gmaw

This program is free software: you can redistribute it and/or modify it under the terms of
the GNU Affero General Public License as published by the Free Software Foundation, either
version 3 of the License, or (at your option) any later version. It is distributed WITHOUT
ANY WARRANTY. See [LICENSE](LICENSE) for the full text.
