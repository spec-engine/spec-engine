#!/usr/bin/env bash
# No smoke so far mutated a tracked file under the canonical fixture (the gitignored index is fine).
source "$(dirname "$0")/_lib.sh"
git diff --exit-code -- "$FIXTURE/" || {
  git diff -- "$FIXTURE/"
  fail "$FIXTURE/ was mutated during the smokes"
}
echo "smoke 14b: $FIXTURE/ unchanged: OK"
