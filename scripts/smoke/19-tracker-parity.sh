#!/usr/bin/env bash
# build_id is byte-identical with SPEC_TRACKER_TOKEN unset and set; the tracker sidecar is never hashed.
source "$(dirname "$0")/_lib.sh"
cold "$FIXTURE_DB"
H_UNSET=$(env -u SPEC_TRACKER_TOKEN "$SPEC" index "$FIXTURE" --json | jq -r '.build_id')
cold "$FIXTURE_DB"
H_SET=$(SPEC_TRACKER_TOKEN=lin_api_dummy "$SPEC" index "$FIXTURE" --json | jq -r '.build_id')
echo "H_UNSET=$H_UNSET"; echo "H_SET=$H_SET"
is_sha256 "$H_UNSET" || fail "H_UNSET is not 64-char hex"
test "$H_UNSET" = "$H_SET" || fail "build_id diverged token-set vs token-unset (sidecar hashed?): $H_UNSET != $H_SET"
echo "smoke 19: tracker build_id parity OK (token set vs unset byte-identical): $H_UNSET"
