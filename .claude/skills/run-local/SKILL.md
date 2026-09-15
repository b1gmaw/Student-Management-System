---
name: run-local
description: Run, render and screenshot the 学生管理システム Apps Script web app locally. Use when asked to run, start, launch, preview, screenshot, or visually check this app, to see a UI or CSS change working, to check the mobile layout, or to deploy it to staging. Covers the local render driver, the test suite, and the clasp push/version/deploy sequence.
---

# Running 学生管理システム

Google Apps Script web app. `Code.js` is the backend, `Index.html` is the **entire**
frontend (markup + CSS + ~10,000 lines of JS in one file).

⚠️ **There is no local runtime and there never will be.** `SpreadsheetApp`,
`HtmlService` and `PropertiesService` only exist inside Google's infrastructure, and
`Code.js` cannot execute here. `npm start` does not exist.

**But the frontend does render locally.** `google.script.run` is a small uniform API,
so the driver stubs it, serves `Index.html` over http and loads it in headless
chromium. That gives you every tab, both themes, any viewport, real computed styles,
and screenshots — without touching the live spreadsheet.

All paths below are relative to the repo root (`Student-Management-System/`).

## Prerequisites

Node and clasp are already present. The driver needs playwright plus a chromium
binary, installed **inside the skill directory** (kept out of git and clasp):

```bash
cd .claude/skills/run-local
npm init -y >/dev/null && npm i playwright@1.62.1
npx --yes playwright@1.62.1 install chromium
```

⚠️ **Do not pass `--with-deps`** — it shells out to `sudo` and fails with
"a terminal is required to read the password". The plain `install chromium` works:
the headless shell runs fine against the libraries already in this container.

## Run (agent path) — the driver

```bash
cd .claude/skills/run-local

node driver.mjs shot --vp phone --tab home        # screenshot one tab
node driver.mjs tabs --vp phone                   # screenshot every tab
node driver.mjs probe --vp phone --tab students   # computed styles for the nav
node driver.mjs overflow --vp phone               # name what slides the page sideways
node driver.mjs errors --vp phone                 # console errors on boot only
```

Options: `--vp phone|tablet|desktop` (390 / 820 / 1440 wide — 820 is exactly the CSS
breakpoint, so it is the boundary case worth checking), `--tab <name>` (`home`,
`students`, `dorms`, `admissions`, `shinsei`, `users`, `account`), `--dark`,
`--as <persona>`, `--out <file>`. Screenshots land in
`.claude/skills/run-local/shots/`.

⚠️ **`--as` matters more than it looks.** The default persona is `master`, which sees
**everything** — so it cannot show a permission-gated screen being wrongly hidden, and
that is a bug class this app keeps hitting (a 営業 holding 管理者権限 could not see
ユーザー管理). Personas: `master`, `sales`, `sales-admin`, `teacher`, `teacher-admin`
— the `-admin` pair carry 管理者権限 while their role and label stay their department,
which is exactly what that flag is for. Check a gated change against a persona that
should *not* see it as well as one that should.

**`probe` is the one that earns its keep.** Screenshots make you squint; `probe`
answers "where did this element actually land" as data:

```bash
node driver.mjs probe --vp phone --tab students
```

```json
{ "horizontalOverflow": false, "bodyPadding": { "top": "48px", "bottom": "74px" },
  "nav": [ { "sel": "#btn-logout", "visible": false, "display": "none" }, ... ],
  "activeTab": { "id": "btn-students", "background": "rgba(0, 0, 0, 0)",
                 "boxShadow": "none", "textAlign": "center" } }
```

That output settles questions like "is the logout button still in the bar", "did the
username reappear", "is the active tab still wearing the desktop look" in one command.

⚠️ **Always check `--vp desktop` too.** The mobile work is confined to one
`@media (max-width: 820px)` block precisely so desktop cannot move; `probe --vp
desktop` is how you prove it. Desktop should show the 220px rail with `#btn-logout`,
`#userBadge` and `#btn-dark-mode` all `visible: true`.

### Fixtures

The stub returns synthetic data from `FIXTURES` in `driver.mjs` — an all-permissions
master user so every tab is reachable. Unlisted endpoints resolve to `null`, which
every caller tolerates. Add a fixture when you need a screen populated.

⚠️ **Fixtures stay synthetic.** The real spreadsheet holds ~600 students' records.
Never point the driver at live data and never paste real rows into it — the
screenshots it writes are ordinary files on disk.

## Test

```bash
./tests/run-all.sh          # 43 suites, plain Node, no framework
node tests/mobile.test.js   # one suite
```

Syntax-check both files before handing anything over:

```bash
cp Code.js /tmp/c.js && node --check /tmp/c.js
python3 -c "
import re
c=open('Index.html').read()
b=re.findall(r'<script>(.*?)</script>',c,re.DOTALL)
open('/tmp/b.js','w').write(b[1])"
node --check /tmp/b.js
```

⚠️ `Index.html` has **two** `<script>` blocks; the application code is the second.

## Deploy to staging

⚠️ `clasp push` uploads files — **it does not deploy**. The web app keeps serving
whatever version its deployment is pinned to. Four steps, not one:

```bash
clasp -P .clasp-staging.json push
clasp -P .clasp-staging.json push        # re-run: expect "Script is already up to date"
clasp -P .clasp-staging.json version "staging vNN - what changed"
clasp -P .clasp-staging.json deploy -i <staging-deployment-id> -V NN -d "staging vNN"
clasp -P .clasp-staging.json deployments # READ THE VERSION BACK
```

Get the deployment id from `clasp -P .clasp-staging.json deployments` and **repoint
the existing one** — a new id hands out a new URL and leaves the bookmarked one on old
code. A bare `clasp push` goes to **production**.

## Human path

There isn't one locally. To see the real app you open the deployed staging URL in a
browser and log in. ⚠️ Staging holds real student records — treat that URL as
sensitive and do not screenshot it into the repo.

## Gotchas

- ⚠️ **`file://` silently breaks the boot.** The app resumes its session from
  `localStorage`, which Chromium blocks on the `file:` origin, so the app sits on the
  PIN screen forever with no error. The driver serves over `http://127.0.0.1` for
  this reason — don't "simplify" it to `page.goto('file://…')`.
- ⚠️ **`--dark` is a `localStorage` flag, not `prefers-color-scheme`.** The app
  reads `sms_theme` in `applySavedTheme()`. Setting only the browser's colour
  scheme renders light and looks like dark mode is broken — the driver sets the flag.
- ⚠️ **Meta tags in `Index.html` are ignored by the real app.** Apps Script serves it
  inside a sandboxed iframe; only `addMetaTag()` in `doGet` reaches the top-level page
  the browser takes its viewport from. Locally the driver sets the viewport directly,
  so **the local render cannot catch a missing viewport tag** — check `doGet`.
- ⚠️ **`.app-sidebar` sets `backdrop-filter`, `-webkit-backdrop-filter` and
  `will-change`**, each of which makes `position: fixed` children resolve against the
  sidebar instead of the viewport. `probe` shows this immediately: a `position: fixed`
  element with a `rect` inside the bar's box rather than at the viewport edge.
- ⚠️ **A stray `</div>` closes `.sb-footer` early**, so `#userBadge`, `#btn-logout`
  and `#btn-dark-mode` are direct children of `.app-sidebar`, not of the footer. A
  `.sb-footer`-scoped selector cannot reach them. `probe` reports each by id for
  exactly this reason.
- **`overflow` skips anything inside a scroller.** The bottom bar's own tabs sit far
  past the viewport by design (`.sb-nav` scrolls them); reporting those buried the one
  element actually widening the page.
- **There is no global `box-sizing: border-box`** in this stylesheet. `width: 100%`
  plus padding overflows. That is what `overflow` found: `.container` at 394px on a
  390px viewport.
- The active bottom-bar tab's underline is a **pre-existing** `border-bottom` on
  `.nav-btn.active`, not something the mobile block adds. `probe` reports
  `borderBottom` so you don't go hunting for a `box-shadow`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `playwright install --with-deps` → "sudo: a terminal is required" | Drop `--with-deps`. The plain `install chromium` works here. |
| `Cannot find package 'playwright'` | You are running the driver from elsewhere. `cd .claude/skills/run-local` first — playwright is installed there, not at the repo root. |
| Driver prints `wrote …png` but the shot is the PIN screen | The stub did not answer `getBootBundle`. Check `FIXTURES.getBootBundle` still matches what `tryResumeSession`'s `onOk` reads (`result.user`, `result.mustSetPassword`). |
| `probe` shows `"visible": false` for everything | The app never booted. Run `node driver.mjs errors` — a page error during boot leaves the sidebar hidden. |
| Tests fail on a wording assertion after editing a message | `tests/wording.test.js` bans internal names (tab names, スナップショット) in user-facing strings. Reword, don't allowlist. |
