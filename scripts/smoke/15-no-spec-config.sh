#!/usr/bin/env bash
# NO_SPEC_CONFIG end to end: one spec-engine/ plus one declared member without a pin.
source "$(dirname "$0")/_lib.sh"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/spec-engine" "$TMP/strangers"
echo '{"name":"strangers","private":true}' > "$TMP/strangers/package.json"
# spec init declares the repository (platform file + marker) and pins it; deleting the pin leaves a declared, unpinned member.
"$SPEC" init "$TMP/strangers" >/dev/null
test -f "$TMP/platform-map.json" || fail "spec init did not write the platform file"
test -f "$TMP/strangers/platform-map.json" || fail "spec init did not write the marker"
rm "$TMP/strangers/spec-engine.member.json"
DCNT=$(index_diagnostics "$TMP")
test "$DCNT" = "1" || { "$SPEC" index "$TMP" --json; fail "expected exactly 1 diagnostic (NO_SPEC_CONFIG), got $DCNT"; }
# The row is a warning, so `check` without --ci exits 0 and --json carries its code.
ROWS=$("$SPEC" check "$TMP" --json)
test "$(echo "$ROWS" | jq 'length')" = "1" || { echo "$ROWS"; fail "expected 1 check row"; }
CODE=$(echo "$ROWS" | jq -r '.[0].code')
test "$CODE" = "NO_SPEC_CONFIG" || { echo "$ROWS"; fail "expected code NO_SPEC_CONFIG, got $CODE"; }
echo "smoke 15: NO_SPEC_CONFIG end-to-end OK (diagnostics=$DCNT, code=$CODE)"
