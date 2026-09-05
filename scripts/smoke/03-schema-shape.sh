#!/usr/bin/env bash
# Open a fresh DB and assert the schema shape.
source "$(dirname "$0")/_lib.sh"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
"$SPEC" __schema-smoke "$TMP/spec-smoke.sqlite"
