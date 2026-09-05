#!/usr/bin/env bash
# spec query "renewal charge" ranks BILLING-009 first through the compiled binary.
source "$(dirname "$0")/_lib.sh"
OUT=$("$SPEC" query "renewal charge" "$FIXTURE" --json)
echo "$OUT" | jq .
LEN=$(echo "$OUT" | jq 'length')
test "$LEN" -ge 1 || fail "expected at least 1 hit, got $LEN"
TOP=$(echo "$OUT" | jq -r '.[0].req_id')
test "$TOP" = "BILLING-009" || fail "expected top hit BILLING-009, got $TOP"
echo "spec query \"renewal charge\" (compiled binary): OK"
