#!/usr/bin/env bash
# --results fires the trusted-red gate: an UNPROVEN_REQ row for BILLING-009, exit 1 (never 2).
# The planted fixture already exits 1, so the row is the signal, not the exit code.
source "$(dirname "$0")/_lib.sh"
SAMPLE_REL=".spec-engine-results-smoke.xml"
cp packages/engine/src/testing/fixtures/junit/bun-green.xml "$FIXTURE/$SAMPLE_REL"
trap 'rm -f "$FIXTURE/$SAMPLE_REL"' EXIT
set +e
cold "$FIXTURE_DB"
OUT=$("$SPEC" check --ci "$FIXTURE" --results "$SAMPLE_REL" --json 2>/dev/null)
EXIT=$?
set -e
test "$EXIT" = "1" || fail "--results run should exit 1 (unproven active req + planted defects), got $EXIT (2 = crash or flag not plumbed through the compiled binary)"
GOT_UNPROVEN=$(echo "$OUT" | jq -r '[.[] | select(.code=="UNPROVEN_REQ") | .req_id] | sort | join(",")')
test -n "$GOT_UNPROVEN" || fail "no UNPROVEN_REQ row in --results --json output: the trusted-red gate did not fire"
echo "$GOT_UNPROVEN" | grep -q 'BILLING-009' || fail "expected UNPROVEN_REQ for BILLING-009 (bun-green.xml does not prove it), got: $GOT_UNPROVEN"
echo "smoke 22: trusted-red gate fired: UNPROVEN_REQ rows: $GOT_UNPROVEN (exit 1, not 2)"
