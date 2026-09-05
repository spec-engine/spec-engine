#!/usr/bin/env bash
# build_id is byte-identical with and without --results on a cold rebuild; results are never hashed.
# The sample JUnit is copied inside the fixture because --results must resolve under the platform dir.
source "$(dirname "$0")/_lib.sh"
SAMPLE_REL=".spec-engine-results-smoke.xml"
cp packages/engine/src/testing/fixtures/junit/bun-green.xml "$FIXTURE/$SAMPLE_REL"
trap 'rm -f "$FIXTURE/$SAMPLE_REL"' EXIT
set +e
cold "$FIXTURE_DB"
OUT_WITHOUT=$("$SPEC" check --ci "$FIXTURE")
cold "$FIXTURE_DB"
OUT_WITH=$("$SPEC" check --ci "$FIXTURE" --results "$SAMPLE_REL")
set -e
H_WITHOUT=$(echo "$OUT_WITHOUT" | grep '^build_id:' | awk '{print $2}')
H_WITH=$(echo "$OUT_WITH" | grep '^build_id:' | awk '{print $2}')
echo "H_WITHOUT=$H_WITHOUT"; echo "H_WITH=$H_WITH"
is_sha256 "$H_WITHOUT" || fail "H_WITHOUT is not 64-char hex"
test "$H_WITH" = "$H_WITHOUT" || fail "build_id diverged with vs without --results (results hashed into the index?): $H_WITH != $H_WITHOUT"
echo "smoke 21: trusted-red build_id parity OK (with/without --results byte-identical): $H_WITH"
