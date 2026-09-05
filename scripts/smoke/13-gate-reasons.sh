#!/usr/bin/env bash
# spec gate distinguishes SUPERSEDED from NOT_FOUND in its JSON reason.
# BILLING-999 is the planted DANGLING_TAG bait, so the unknown id here is a different one.
source "$(dirname "$0")/_lib.sh"
gate_reason() {
  set +e
  OUT=$("$SPEC" gate "$1" "$2" "$FIXTURE" --json)
  EXIT=$?
  set -e
  test "$EXIT" = "1" || { echo "$OUT"; fail "spec gate $1 $2 expected exit 1 ($3), got $EXIT"; }
  REASON=$(echo "$OUT" | jq -r '.reason')
  test "$REASON" = "$3" || { echo "$OUT"; fail "expected reason $3, got $REASON"; }
}
gate_reason mobile BILLING-001 SUPERSEDED
gate_reason api COMPLETELY-NONEXISTENT-9999 NOT_FOUND
echo "smoke 13: spec gate distinct reasons OK (SUPERSEDED + NOT_FOUND)"
