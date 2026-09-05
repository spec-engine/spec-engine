#!/usr/bin/env bash
# spec propagation BILLING-009 emits the three-row per-repo state through the compiled binary.
source "$(dirname "$0")/_lib.sh"
OUT=$("$SPEC" propagation BILLING-009 "$FIXTURE" --json)
echo "$OUT" | jq .
field() { echo "$OUT" | jq -r "map(select(.repo==\"$1\")) | .[0].$2"; }
test "$(echo "$OUT" | jq 'length')" = "3" || fail "expected 3 rows (admin, api, mobile); got $(echo "$OUT" | jq 'length')"
test "$(field api state)" = "MIGRATED_VERIFIED" || fail "api.state should be MIGRATED_VERIFIED"
test "$(field api via_req_id)" = "null" || fail "api.via_req_id should be null"
test "$(field mobile state)" = "ON_PREDECESSOR" || fail "mobile.state should be ON_PREDECESSOR"
test "$(field mobile via_req_id)" = "BILLING-001" || fail "mobile.via_req_id should be BILLING-001"
test "$(field mobile drifted)" = "true" || fail "mobile.drifted should be true"
test "$(field admin state)" = "ON_OTHER_DOMAIN_REQ" || fail "admin.state should be ON_OTHER_DOMAIN_REQ"
test "$(field admin via_req_id)" = "BILLING-007" || fail "admin.via_req_id should be BILLING-007"
test "$(field admin drifted)" = "false" || fail "admin.drifted should be false"
echo "spec propagation BILLING-009 (compiled binary): OK"
