#!/usr/bin/env bash
# A schema-version mismatch triggers a silent rebuild.
source "$(dirname "$0")/_lib.sh"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
"$SPEC" __schema-mismatch-smoke "$TMP/spec-smoke.sqlite"
