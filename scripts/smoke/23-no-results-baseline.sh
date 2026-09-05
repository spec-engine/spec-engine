#!/usr/bin/env bash
# Without --results the --json array is exactly the planted baseline and PROOFS_UNCONFIRMED goes to stderr.
source "$(dirname "$0")/_lib.sh"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
set +e
OUT=$("$SPEC" check --ci "$FIXTURE" --json 2>"$TMP/stderr")
EXIT=$?
set -e
test "$EXIT" = "1" || fail "no-results --json run should exit 1 (planted errors), got $EXIT"
expect_same "no-results --json baseline drift (PROOFS_UNCONFIRMED leaked into the stdout array?)" \
  "$(project_diagnostics <<<"$OUT")" "$(baseline_diagnostics)"
grep -q 'PROOFS_UNCONFIRMED' "$TMP/stderr" || { cat "$TMP/stderr" || true; fail "no-results run should emit a PROOFS_UNCONFIRMED note on stderr"; }
echo "smoke 23: no-results --json baseline re-verified (set byte-identical; PROOFS_UNCONFIRMED on stderr)"
