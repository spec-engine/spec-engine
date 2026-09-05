#!/usr/bin/env bash
# The dogfood self-gate, trusted-red: this checkout's own requirements against its own JUnit results.
# The repo root is the platform dir, so the results path is platform-relative and .spec-engine/ is gitignored.
source "$(dirname "$0")/_lib.sh"
mkdir -p .spec-engine
bun test --reporter=junit --reporter-outfile=.spec-engine/results.xml
"$SPEC" check . --ci --results .spec-engine/results.xml
echo "smoke 16: dogfood self-gate trusted-red OK (exit 0 with repo JUnit ingested)"
