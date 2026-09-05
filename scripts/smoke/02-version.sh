#!/usr/bin/env bash
# --version exits 0 and prints semver.
source "$(dirname "$0")/_lib.sh"
"$SPEC" --version | grep -E '^[0-9]+\.[0-9]+\.[0-9]+'
