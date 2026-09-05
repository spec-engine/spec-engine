#!/usr/bin/env bash
# spec get and spec list through the compiled binary: one object, [] for an unknown id, the superseded row.
source "$(dirname "$0")/_lib.sh"
ONE=$("$SPEC" get BILLING-009 "$FIXTURE" --json --no-prompt)
test "$(echo "$ONE" | jq -r '.id')" = "BILLING-009" || { echo "$ONE"; fail "get should answer BILLING-009"; }
test "$(echo "$ONE" | jq -r '.status')" = "Active" || { echo "$ONE"; fail "BILLING-009 should be Active"; }
NONE=$("$SPEC" get BILLING-999 "$FIXTURE" --json --no-prompt 2>/dev/null)
test "$NONE" = "[]" || { echo "$NONE"; fail "unknown id should print []"; }
SUP=$("$SPEC" list "$FIXTURE" --status superseded --json --no-prompt)
echo "$SUP" | jq -e 'map(.id) | index("BILLING-001") != null' >/dev/null || { echo "$SUP"; fail "list --status superseded should include BILLING-001"; }
if "$SPEC" list "$FIXTURE" --status retired --json --no-prompt >/dev/null 2>&1; then
  fail "--status retired should exit 2"
fi
echo "get/list smoke: OK"
