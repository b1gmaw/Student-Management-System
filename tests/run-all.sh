#!/usr/bin/env bash
# Runs every suite. Exit non-zero if any fail.
cd "$(dirname "$0")"
fail=0
for t in *.test.js; do
  printf "%-26s " "$t"
  if out=$(node "$t" 2>&1); then echo "PASS"; else echo "FAIL"; echo "$out" | tail -20; fail=1; fi
done
[ $fail -eq 0 ] && echo "--- all suites passed" || echo "--- FAILURES"
exit $fail
