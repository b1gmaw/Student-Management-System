# 学生管理システム

A **deployed, in-production** Google Apps Script web app for a Japanese
Language School. ~10–20 staff use it daily for interview scheduling, dorm management,
interview results, placement tests, student records and recruitment tracking.

Private repository. This README covers only **getting a second machine working** — the
real documentation is [`CLAUDE.md`](CLAUDE.md) (rules and the traps behind them) and
[`TECHNICAL_REFERENCE.md`](TECHNICAL_REFERENCE.md) (architecture and data model). Read
`CLAUDE.md` before your first push from a new checkout.

---

## ⚠️ Read this before your first `clasp push`

**A bare `clasp push` goes straight to PRODUCTION. There is no confirmation step.**

| Command | Target |
|---|---|
| `clasp push` | **PRODUCTION** — real users, immediately |
| `clasp -P .clasp-staging.json push` | staging |

And **pushing is not deploying**: the web app keeps serving whatever version its
deployment is pinned to, so a push alone changes nothing a tester can see. The full
four-step procedure — push, version, deploy to the *existing* deployment id, then read
the version number back — is **`CLAUDE.md` rule 9**. Follow it there; it is not repeated
here so the two cannot drift apart.

## What a clone does *not* give you

Cloning gets the code. These four things are per-machine or per-project and are
deliberately absent from the repo:

| Missing | Where it comes from |
|---|---|
| `~/.clasprc.json` — clasp OAuth credentials | `clasp login`, once per machine. Never commit it. |
| `SYSTEM_PIN` script property | Set by hand in ⚙ Project Settings → Script Properties. ⚠️ Staging and production each need **their own**, and it does **not** survive File → Make a copy. Unset means the master account cannot log in — that is intentional, there is no in-file fallback. |
| `MAINTENANCE_UNLOCK` script property | Today's date in Asia/Tokyo `yyyy-MM-dd`, for `profileApp` / `authoriseServices`. Self-expiring. |
| `node_modules/` for the render driver | `npm install` in the skill directory (below). |

## Setup on a new machine

```bash
git clone <this repo> && cd Student-Management-System

npm install -g @google/clasp
clasp login                       # writes ~/.clasprc.json

./tests/run-all.sh                # 43 suites, plain Node, no framework — confirms the checkout
```

Optional, for the local render/screenshot driver:

```bash
cd .claude/skills/run-local
npm install && npx playwright install chromium
node driver.mjs shot --vp desktop --tab dorms
```

## ⚠️ Git and Apps Script are two separate syncs

A `git pull` updates your files. It does **not** touch the live Apps Script project — and
that project is independently editable in Google's web editor, so it may have moved
without any commit recording it.

Before pushing from a machine that has been idle, check what is actually live:

```bash
D=$(mktemp -d) && cp .clasp.json "$D/" && (cd "$D" && clasp pull)
diff Code.js "$D/Code.js" && diff Index.html "$D/Index.html"
```

The same pull-and-diff is how you prove staging and production match, which is worth
doing whenever they are supposed to be identical — `clasp deployments` shows you a
version *number*, which tells you nothing about whether the *content* agrees.

## Layout

| Path | Role |
|---|---|
| `Code.js` | Backend |
| `Index.html` | **Entire** frontend — markup, CSS and JS. ⚠️ Two `<script>` blocks; the app code is the **second**. |
| `Template.html` | Dorm room PDF template |
| `Shinsei_Code.js`, `Shinsei_Template.html` | Parked 申請 module |
| `tests/` | 43 suites; `./tests/run-all.sh`. Excluded from `clasp push` by `.claspignore`. |
| `.claude/skills/run-local/` | Local render driver (Playwright) |
| `.clasp.json` / `.clasp-staging.json` | Production / staging project ids |


## License

Copyright (C) 2026 b1gmaw

This program is free software: you can redistribute it and/or modify it under the terms of
the GNU Affero General Public License as published by the Free Software Foundation, either
version 3 of the License, or (at your option) any later version. It is distributed WITHOUT
ANY WARRANTY. See [LICENSE](LICENSE) for the full text.
