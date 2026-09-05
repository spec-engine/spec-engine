#!/usr/bin/env bash
# Cold-rebuild build_id equivalence: warm, warm re-index, and cold rebuild all agree.
source "$(dirname "$0")/_lib.sh"
H1=$(build_id "$FIXTURE")
H2=$(build_id "$FIXTURE")
cold "$FIXTURE_DB"
H3=$(build_id "$FIXTURE")
echo "H1=$H1"; echo "H2=$H2"; echo "H3=$H3"
is_sha256 "$H1" || fail "H1 is not 64-char hex"
test "$H1" = "$H2" || fail "warm re-index diverged: $H1 != $H2"
test "$H1" = "$H3" || fail "cold rebuild diverged: $H1 != $H3"
echo "cold-rebuild build_id stable: $H1"
