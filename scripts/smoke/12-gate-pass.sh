#!/usr/bin/env bash
# spec gate api BILLING-009 passes with the four contract fields.
source "$(dirname "$0")/_lib.sh"
set +e
OUT=$("$SPEC" gate api BILLING-009 "$FIXTURE" --json)
EXIT=$?
set -e
test "$EXIT" = "0" || { echo "$OUT"; fail "spec gate api BILLING-009 expected exit 0 (PASS), got $EXIT"; }
PARSED=$(echo "$OUT" | jq -r '"\(.reason)\t\(.repo)\t\(.req_id)\t\(.pinned_spec_version)"')
EXPECTED=$(printf "%b" "PASS\tapi\tBILLING-009\t2")
expect_same "spec gate JSON shape drift ($OUT)" "$PARSED" "$EXPECTED"
echo "smoke 12: spec gate PASS OK ($OUT)"
