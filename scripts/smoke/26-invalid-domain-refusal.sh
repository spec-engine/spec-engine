#!/usr/bin/env bash
# An invalid SPEC.json refuses the build: spec index and spec check --ci exit 1 and print only its INVALID_DOMAIN_FILE rows.
# @spec INDX-016
# @spec INDX-030
# @spec INDX-031
source "$(dirname "$0")/_lib.sh"
TMP=$(fixture_copy); trap 'rm -rf "$TMP"' EXIT
FILE=spec-engine/BILLING/SPEC.json
jq '.requirements[0].supersededBy = ["X"]' "$TMP/$FILE" > "$TMP/planted.json"
mv "$TMP/planted.json" "$TMP/$FILE"

# Each row is CODE<TAB>source_file<TAB>detail; every one must name the file and the field.
assert_only_refusal_rows() {
  local label=$1 rows=$2
  test -n "$rows" || fail "$label printed no rows"
  echo "$rows" | awk -F'\t' -v f="$FILE" '$1 != "INVALID_DOMAIN_FILE" || $2 != f || $3 !~ /requirements\.0\.supersededBy/ { bad = 1 } END { exit bad }' \
    || { echo "$rows"; fail "$label printed a row other than INVALID_DOMAIN_FILE for $FILE requirements.0.supersededBy"; }
}

set +e
INDEX_OUT=$("$SPEC" index "$TMP" --json 2>/dev/null)
INDEX_EXIT=$?
cold "$TMP/.spec-engine/index.sqlite"
CHECK_OUT=$("$SPEC" check --ci "$TMP" --json 2>/dev/null)
CHECK_EXIT=$?
set -e

test "$INDEX_EXIT" = "1" || fail "spec index should exit 1 on an invalid SPEC.json, got $INDEX_EXIT"
assert_only_refusal_rows "spec index --json" \
  "$(echo "$INDEX_OUT" | jq -r '.[] | "\(.code)\t\(.source_file)\t\(.detail)"')"

test "$CHECK_EXIT" = "1" || fail "spec check --ci should exit 1 on an invalid SPEC.json, got $CHECK_EXIT"
assert_only_refusal_rows "spec check --ci --json" \
  "$(echo "$CHECK_OUT" | jq -r '.[] | "\(.code)\t\(.source_file)\t\(.detail)"')"

echo "smoke 26: an invalid SPEC.json refused the build; index and check --ci printed only its INVALID_DOMAIN_FILE rows (exit 1)"
