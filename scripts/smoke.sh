#!/usr/bin/env bash
#
# Run the compiled-binary smokes locally, the same scripts .github/workflows/ci.yml runs.
#
#     bash scripts/smoke.sh        # every scripts/smoke/NN-*.sh in order
#     bash scripts/smoke.sh 7      # one smoke by number (7, 07, 6b, 14b)
#
# Build first: bun run build:cli (SPEC_BIN points a smoke at another binary).

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

if [ $# -gt 0 ]; then
  n=$1
  case "$n" in [0-9]|[0-9][a-z]) n="0$n" ;; esac
  scripts=(scripts/smoke/"$n"-*.sh)
  [ -e "${scripts[0]}" ] || { echo "no smoke numbered $1 under scripts/smoke/"; exit 2; }
else
  scripts=(scripts/smoke/[0-9]*.sh)
fi

failed=0
for script in "${scripts[@]}"; do
  echo "── smoke: $script"
  if bash "$script"; then
    echo "   ok"
  else
    echo "   FAILED: $script"
    failed=1
  fi
done
[ "$failed" = 0 ] && echo "All smokes green." || echo "A smoke failed."
exit "$failed"
