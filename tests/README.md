# Local test suites

There is no test framework. Each file is a standalone Node script that
transcribes logic out of `Code.js` / `Index.html` and asserts against it.

Run them all:

    ./tests/run-all.sh

These are **excluded from clasp** by `.claspignore` — `skipSubdirectories` is
false, so without that they would be pushed into the live Apps Script project.

Because the logic is transcribed rather than imported (Apps Script globals like
`SpreadsheetApp` do not exist in Node), a suite can drift from the real code.
When you change one of the functions these cover, update the transcription in
the same commit.
