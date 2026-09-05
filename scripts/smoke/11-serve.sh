#!/usr/bin/env bash
# spec serve binds a real server and answers /api/coverage, /, and /api/resolve.
source "$(dirname "$0")/_lib.sh"
TMP=$(mktemp -d)
trap 'serve_stop; rm -rf "$TMP"' EXIT
serve_start "$FIXTURE"
curl -sf "http://127.0.0.1:$PORT/api/coverage" > "$TMP/coverage.json" || fail "/api/coverage curl failed"
COV_LEN=$(jq -r 'length' "$TMP/coverage.json")
test "$COV_LEN" -ge 1 || { cat "$TMP/coverage.json"; fail "/api/coverage returned $COV_LEN rows (expected >= 1)"; }
curl -sf "http://127.0.0.1:$PORT/" > "$TMP/coverage.html" || fail "GET / curl failed"
grep -qi 'coverage' "$TMP/coverage.html" || { head -c 1000 "$TMP/coverage.html"; fail "GET / body did not contain 'Coverage'"; }
curl -sfG "http://127.0.0.1:$PORT/api/resolve" \
  --data-urlencode 'files=api/src/renew.ts' \
  --data-urlencode 'files=api/src/charge.ts' \
  > "$TMP/resolve.json" || fail "/api/resolve curl failed"
RES_LEN=$(jq -r 'length' "$TMP/resolve.json")
test "$RES_LEN" = "2" || { cat "$TMP/resolve.json"; fail "/api/resolve returned $RES_LEN items (expected 2)"; }
echo "spec serve (compiled binary): OK"
