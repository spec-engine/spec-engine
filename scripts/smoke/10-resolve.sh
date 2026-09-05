#!/usr/bin/env bash
# spec resolve returns BILLING-002 and BILLING-009 for the two canonical files.
source "$(dirname "$0")/_lib.sh"
OUT=$("$SPEC" resolve api/src/renew.ts api/src/charge.ts "$FIXTURE" --json)
echo "$OUT" | jq .
test "$(echo "$OUT" | jq 'length')" = "2" || fail "expected 2 items, got $(echo "$OUT" | jq 'length')"
IDS=$(echo "$OUT" | jq -r '.[].id' | sort | tr '\n' ',' | sed 's/,$//')
test "$IDS" = "BILLING-002,BILLING-009" || fail "expected sorted IDs BILLING-002,BILLING-009, got $IDS"
test "$(echo "$OUT" | jq -r '[.[].key] | unique | length')" = "1" || fail "expected all rows to share key=BILLING"
test "$(echo "$OUT" | jq -r '[.[].key] | unique | .[0]')" = "BILLING" || fail "expected unique key BILLING"
INVALID=$(echo "$OUT" | jq -r '.[] | select((.status | IN("Active","Superseded","Draft","Retired")) | not) | .id')
test -z "$INVALID" || fail "rows with invalid status: $INVALID"
echo "spec resolve (compiled binary): OK"
