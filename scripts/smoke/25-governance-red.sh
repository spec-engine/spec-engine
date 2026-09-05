#!/usr/bin/env bash
# Governance-red on a cold build: deleting a domain file in the working tree yields REQUIREMENT_REMOVED, exit 1.
# The planted fixture already exits 1, so the row is the signal, not the exit code.
source "$(dirname "$0")/_lib.sh"
TMP=$(fixture_copy); trap 'rm -rf "$TMP"' EXIT
git_baseline "$TMP"
rm "$TMP/spec-engine/BILLING/SPEC.json"
DB="$TMP/.spec-engine/index.sqlite"
set +e
cold "$DB"
OUT=$("$SPEC" check --ci "$TMP" --base HEAD --json 2>/dev/null)
EXIT=$?
set -e
test "$EXIT" = "1" || fail "governance-red run should exit 1, got $EXIT (2 = crash or --base not plumbed through the compiled binary)"
GOT_REMOVED=$(echo "$OUT" | jq -r '[.[] | select(.code=="REQUIREMENT_REMOVED") | .req_id] | sort | join(",")')
test -n "$GOT_REMOVED" || fail "no REQUIREMENT_REMOVED row in --base --json output: the governance gate did not fire"
echo "smoke 25: governance-red fired on a cold build: REQUIREMENT_REMOVED rows: $GOT_REMOVED (exit 1, not 2)"
