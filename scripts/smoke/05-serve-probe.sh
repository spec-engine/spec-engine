#!/usr/bin/env bash
# The compiled binary serves the embedded webapp HTML.
source "$(dirname "$0")/_lib.sh"
"$SPEC" serve --probe
