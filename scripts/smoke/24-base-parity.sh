#!/usr/bin/env bash
# build_id is byte-identical with and without --base on a cold rebuild.
# Governance needs the platform dir to be a git root, so it runs on a committed copy of the fixture.
source "$(dirname "$0")/_lib.sh"
TMP=$(fixture_copy); trap 'rm -rf "$TMP"' EXIT
git_baseline "$TMP"
DB="$TMP/.spec-engine/index.sqlite"
set +e
cold "$DB"
OUT_WITHOUT=$("$SPEC" check --ci "$TMP")
cold "$DB"
OUT_WITH=$("$SPEC" check --ci "$TMP" --base HEAD)
set -e
H_WITHOUT=$(echo "$OUT_WITHOUT" | grep '^build_id:' | awk '{print $2}')
H_WITH=$(echo "$OUT_WITH" | grep '^build_id:' | awk '{print $2}')
echo "H_WITHOUT=$H_WITHOUT"; echo "H_WITH=$H_WITH"
is_sha256 "$H_WITHOUT" || fail "H_WITHOUT is not 64-char hex"
test "$H_WITH" = "$H_WITHOUT" || fail "build_id diverged with vs without --base (governance perturbed the cold-build hash?): $H_WITH != $H_WITHOUT"
echo "smoke 24: governance build_id parity OK (with/without --base byte-identical): $H_WITH"
