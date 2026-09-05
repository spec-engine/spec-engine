#!/usr/bin/env bash
# spec init scaffolds a member config in an ad-hoc tmp platform and a re-run is byte-idempotent.
source "$(dirname "$0")/_lib.sh"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/spec-engine" "$TMP/member"
"$SPEC" init "$TMP/member"
CFG="$TMP/member/spec-engine.member.json"
test -f "$CFG" || fail "spec init did not write $CFG"
PIN=$(jq -r '.specs' "$CFG")
test "$PIN" != "null" || fail "missing specs key in $CFG"
echo "smoke 14: wrote $CFG with pin=$PIN"
BEFORE=$(cat "$CFG")
"$SPEC" init "$TMP/member"
AFTER=$(cat "$CFG")
expect_same "spec init not idempotent: file bytes differ across re-run" "$AFTER" "$BEFORE"
echo "smoke 14: idempotent re-run OK"
