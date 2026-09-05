#!/usr/bin/env bash
# Cold-rebuild build_id stays byte-stable with an UNLISTED_REPO stranger in the mix.
source "$(dirname "$0")/_lib.sh"
TMP=$(fixture_copy); trap 'rm -rf "$TMP"' EXIT
# platform-map reports a directory as a repository only when it has a .git entry or a package.json.
mkdir -p "$TMP/strangers"
echo '{"name":"strangers","private":true}' > "$TMP/strangers/package.json"
DB="$TMP/.spec-engine/index.sqlite"
H1=$(build_id "$TMP")
H2=$(build_id "$TMP")
cold "$DB"
H3=$(build_id "$TMP")
echo "H1=$H1"; echo "H2=$H2"; echo "H3=$H3"
is_sha256 "$H1" || fail "H1 is not 64-char hex"
test "$H1" = "$H2" || fail "warm re-index diverged (with stray sibling): $H1 != $H2"
test "$H1" = "$H3" || fail "cold rebuild diverged (with stray sibling): $H1 != $H3"
# Parse-layer rows only: UNLISTED_REPO for strangers/ and the planted UNKNOWN_ROLE on BILLING-002.
DCNT=$(index_diagnostics "$TMP")
test "$DCNT" = "2" || fail "expected exactly 2 parse diagnostics against tmp+stranger (UNLISTED_REPO + UNKNOWN_ROLE), got $DCNT"
# The fixture's planted errors make check exit 1; the row under test is the stranger's.
ROWS=$("$SPEC" check "$TMP" --json || true)
UNLISTED=$(echo "$ROWS" | jq -c '[.[] | select(.code == "UNLISTED_REPO")] | map({severity, source_file, repo})')
test "$UNLISTED" = '[{"severity":"warning","source_file":"strangers","repo":null}]' || { echo "$ROWS"; fail "expected one UNLISTED_REPO warning for strangers/, got: $UNLISTED"; }
echo "cold-rebuild build_id stable WITH stray sibling: $H1"
