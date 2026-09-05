#!/usr/bin/env bash
# --help exits 0 and prints usage.
source "$(dirname "$0")/_lib.sh"
"$SPEC" --help | grep -q "spec"
