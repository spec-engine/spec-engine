#!/usr/bin/env bash
# UNSOURCED_CHANGE is off by default and adds exactly one BILLING-001 row under --unsourced-change.
source "$(dirname "$0")/_lib.sh"
set +e
OUT_A=$("$SPEC" check --ci "$FIXTURE" --json)
EXIT_A=$?
set -e
test "$EXIT_A" = "1" || fail "no-flag run should exit 1 (planted errors), got $EXIT_A"
expect_same "no-flag diagnostic set drift (UNSOURCED_CHANGE leaked at the dist layer?)" \
  "$(project_diagnostics <<<"$OUT_A")" "$(baseline_diagnostics)"
EXPECTED_FLAG=$( { baseline_diagnostics; printf "%b\n" "UNSOURCED_CHANGE\t\tBILLING-001"; } | sort)
set +e
OUT_B=$("$SPEC" check --ci "$FIXTURE" --json --unsourced-change)
EXIT_B=$?
set -e
test "$EXIT_B" = "1" || fail "flagged run should still exit 1 (a warning never flips the exit), got $EXIT_B"
expect_same "flagged diagnostic set drift (expected the baseline plus one UNSOURCED_CHANGE row)" \
  "$(project_diagnostics <<<"$OUT_B")" "$EXPECTED_FLAG"
echo "smoke 18: UNSOURCED_CHANGE off-by-default + flagged set OK"
