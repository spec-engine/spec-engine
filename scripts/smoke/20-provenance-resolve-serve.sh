#!/usr/bin/env bash
# provenance --resolve-issues degrades without a token, stays deterministic, leaves the default
# path alone, and the flag-gated /provenance page and /api/provenance route serve the matrix.
source "$(dirname "$0")/_lib.sh"
TMP=$(mktemp -d)
trap 'serve_stop; rm -rf "$TMP"' EXIT
OUT=$(env -u SPEC_TRACKER_TOKEN "$SPEC" provenance "$FIXTURE" --resolve-issues)
echo "$OUT" | grep -q "ENG-1432" || { echo "$OUT"; fail "degraded --resolve-issues missing bare opaque id ENG-1432"; }
echo "$OUT" | grep -q "set SPEC_TRACKER_TOKEN" || { echo "$OUT"; fail "degraded --resolve-issues missing the 'set SPEC_TRACKER_TOKEN' hint"; }
OUT_A=$(env -u SPEC_TRACKER_TOKEN "$SPEC" provenance "$FIXTURE" --fresh --resolve-issues)
OUT_B=$(env -u SPEC_TRACKER_TOKEN "$SPEC" provenance "$FIXTURE" --fresh --resolve-issues)
expect_same "degraded --resolve-issues not deterministic across cold rebuild" "$OUT_B" "$OUT_A"
DEF=$("$SPEC" provenance "$FIXTURE" --json)
echo "$DEF" | jq .
test "$(echo "$DEF" | jq 'length')" -ge 1 || fail "default provenance --json (no flag) should have >= 1 row"
serve_start "$FIXTURE" SPEC_FLAGS=provenance
curl -sf "http://127.0.0.1:$PORT/provenance" > "$TMP/prov.html" || fail "GET /provenance curl failed"
grep -qi 'Provenance matrix' "$TMP/prov.html" || { head -c 1000 "$TMP/prov.html"; fail "GET /provenance body missing the 'Provenance matrix' heading"; }
grep -q 'ENG-1432' "$TMP/prov.html" || { head -c 1000 "$TMP/prov.html"; fail "GET /provenance served no matrix rows despite SPEC_FLAGS=provenance"; }
curl -sf "http://127.0.0.1:$PORT/api/provenance" > "$TMP/prov-api.json" || fail "GET /api/provenance curl failed"
test "$(jq -r 'if type=="array" then "array" else "not-array" end' "$TMP/prov-api.json")" = "array" || { cat "$TMP/prov-api.json"; fail "/api/provenance did not return a JSON array"; }
test "$(jq -r 'length' "$TMP/prov-api.json")" -ge 1 || { cat "$TMP/prov-api.json"; fail "/api/provenance returned an empty array"; }
echo "smoke 20: provenance --resolve-issues degraded + /provenance served OK"
