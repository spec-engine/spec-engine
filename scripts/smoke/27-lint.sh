#!/usr/bin/env bash
# The statement rules: spec req refuses a rule-breaking statement with exit 2, and spec lint and spec check report one already in the book.
# @spec REQ-060
# @spec CHCK-068
# @spec CHCK-067
# @spec CHCK-058
source "$(dirname "$0")/_lib.sh"
TMP=$(fixture_copy); trap 'rm -rf "$TMP"' EXIT
FILE=spec-engine/BILLING/SPEC.json
BAD="The billing service shall charge renewals, which it previously skipped."

"$SPEC" lint "$TMP" >/dev/null || fail "spec lint should exit 0 on the clean fixture"

before=$(cat "$TMP/$FILE")
set +e
REQ_ERR=$("$SPEC" req BILLING "$TMP" --text "$BAD" 2>&1 >/dev/null)
REQ_EXIT=$?
set -e
test "$REQ_EXIT" = "2" || fail "spec req should exit 2 on a rule-breaking statement, got $REQ_EXIT"
grep -q 'no-history: "previously"' <<<"$REQ_ERR" || fail "spec req did not print the no-history finding: $REQ_ERR"
test "$(cat "$TMP/$FILE")" = "$before" || fail "spec req wrote despite the refusal"

ID=$(jq -r '[.requirements[] | select(.status == "active")][0].id' "$TMP/$FILE")
jq --arg s "$BAD" --arg id "$ID" '(.requirements[] | select(.id == $id) | .statement) = $s' \
  "$TMP/$FILE" > "$TMP/planted.json"
mv "$TMP/planted.json" "$TMP/$FILE"

set +e
LINT_OUT=$("$SPEC" lint "$ID" "$TMP" --json 2>/dev/null)
LINT_EXIT=$?
set -e
test "$LINT_EXIT" = "1" || fail "spec lint should exit 1 on a finding, got $LINT_EXIT"
test "$(jq -r '.[0].rule' <<<"$LINT_OUT")" = "no-history" || fail "spec lint --json: $LINT_OUT"

set +e
CHECK_OUT=$("$SPEC" check --ci "$TMP" --json 2>/dev/null)
set -e
jq -e --arg id "$ID" 'any(.[]; .code == "STATEMENT_RULES" and .req_id == $id and .severity == "error")' \
  <<<"$CHECK_OUT" >/dev/null || fail "spec check did not report STATEMENT_RULES for $ID"

echo "smoke 27: spec req refused a rule-breaking statement (exit 2); spec lint and spec check reported it once planted"
