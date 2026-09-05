#!/usr/bin/env bash
# spec init declares a member in an ad-hoc tmp platform, writes its config, and a re-run is byte-idempotent.
source "$(dirname "$0")/_lib.sh"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/spec-engine" "$TMP/member"
echo '{"name":"member","private":true}' > "$TMP/member/package.json"
"$SPEC" init "$TMP/member"
CFG="$TMP/member/spec-engine.member.json"
test -f "$CFG" || fail "spec init did not write $CFG"
test "$(jq -r '.members[0]' "$TMP/platform-map.json")" = "member" || fail "spec init did not declare member in $TMP/platform-map.json"
test "$(jq -r '.platform' "$TMP/member/platform-map.json")" = "$(basename "$TMP")" || fail "spec init did not write the member marker"
PIN=$(jq -r '.specs' "$CFG")
test "$PIN" != "null" || fail "missing specs key in $CFG"
echo "smoke 14: wrote $CFG with pin=$PIN"
BEFORE=$(cat "$CFG")
PLATFORM_BEFORE=$(cat "$TMP/platform-map.json")
"$SPEC" init "$TMP/member"
AFTER=$(cat "$CFG")
expect_same "spec init not idempotent: file bytes differ across re-run" "$AFTER" "$BEFORE"
expect_same "spec init not idempotent: the platform file changed across re-run" "$(cat "$TMP/platform-map.json")" "$PLATFORM_BEFORE"
echo "smoke 14: idempotent re-run OK"
