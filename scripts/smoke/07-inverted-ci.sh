#!/usr/bin/env bash
# The inverted CI assertion: check --ci exits 1 with exactly the planted diagnostic set.
source "$(dirname "$0")/_lib.sh"
set +e
OUT=$("$SPEC" check --ci "$FIXTURE" --json)
EXIT=$?
set -e
test "$EXIT" = "1" || fail "spec check --ci should exit 1, got $EXIT"
GOT=$(project_diagnostics <<<"$OUT")
expect_same "diagnostic set drift (inverted CI assertion)" "$GOT" "$(baseline_diagnostics)"
echo "inverted CI assertion: OK"
