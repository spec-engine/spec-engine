#!/usr/bin/env bash
# spec provenance: a non-empty deterministic matrix and an exact reverse lookup by issue.
source "$(dirname "$0")/_lib.sh"
OUT=$("$SPEC" provenance "$FIXTURE" --json)
echo "$OUT" | jq .
test "$(echo "$OUT" | jq 'length')" -ge 1 || fail "provenance --json should have >= 1 row"
OUT2=$("$SPEC" provenance "$FIXTURE" --fresh --json)
expect_same "provenance --json not deterministic across cold rebuild" "$OUT2" "$OUT"
REV=$("$SPEC" provenance ENG-1432 "$FIXTURE" --json)
echo "$REV" | jq .
test "$(echo "$REV" | jq 'length')" -ge 1 || fail "reverse lookup ENG-1432 empty"
test "$(echo "$REV" | jq -r 'all(.[]; .issue_id=="ENG-1432")')" = "true" || fail "reverse lookup returned rows whose issue_id != ENG-1432"
echo "smoke 17: spec provenance (compiled binary) OK"
