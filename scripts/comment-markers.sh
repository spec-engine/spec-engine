#!/usr/bin/env bash
#
# scripts/comment-markers.sh — the process-marker ratchet.
#
#     bash scripts/comment-markers.sh            # check (the default)
#     bash scripts/comment-markers.sh --update   # rewrite the ledger
#
# A marker is a token that names how the code came to be rather than what it
# does: a work-round id, a plan or phase or wave number, a pitfall, a review
# round. `@spec KEY-NNN` is the sanctioned way to point a line at its behavior
# and is never matched here.
#
# This is a ratchet, not a ban, because 65 files still carry markers. A file
# absent from the ledger must carry zero. A listed file may not exceed its
# recorded count, and may not sit under it either, so stripping a file moves
# the ledger in the same commit and the number can only fall.

set -uo pipefail
cd "$(dirname "$0")/.."

DEBT="scripts/comment-marker-debt.txt"
MARKER='(WR-[0-9]+|Pitfall [0-9]+|Phase [0-9]+|[Ww]ave [0-9]+|[Pp]lan [0-9]{2}-[0-9]{2}|review-fix)'

sources() {
  git ls-files -- packages | grep -E '^packages/[^/]+/src/.*\.tsx?$'
}

current() {
  local files=()
  while IFS= read -r f; do files+=("$f"); done < <(sources)
  # One grep over every source file rather than one per file: `-c` with several
  # operands prints `<path>:<count>`, and /dev/null guarantees several so the
  # path prefix is never dropped on a single-file tree.
  grep -cE "$MARKER" /dev/null "${files[@]}" 2>/dev/null |
    awk -F: '$2 > 0 { printf "%s\t%s\n", $2, $1 }' || true
}

# Self-tests: the pattern must catch a planted marker and must ignore a bare
# @spec tag, so a regressed pattern fails loudly instead of passing everything.
if ! printf 'const x = 1; // WR-01 review-fix\n' | grep -qE "$MARKER"; then
  echo "SELF-TEST FAILED: the marker pattern no longer matches a planted marker"
  exit 1
fi
if printf '// @spec CHCK-026\n' | grep -qE "$MARKER"; then
  echo "SELF-TEST FAILED: the marker pattern matches a bare @spec tag"
  exit 1
fi

if [ "${1:-}" = "--update" ]; then
  current > "$DEBT"
  echo "wrote ${DEBT} ($(wc -l < "$DEBT" | tr -d ' ') files)"
  exit 0
fi

if [ ! -f "$DEBT" ]; then
  echo "MISSING: ${DEBT} (run: bash scripts/comment-markers.sh --update)"
  exit 1
fi

if ! delta=$(diff "$DEBT" <(current)); then
  echo "FORBIDDEN: the process-marker ledger disagrees with the tree (< ledger, > actual)."
  echo "A file absent from the ledger must carry zero markers; a listed file's count"
  echo "may only shrink, and the ledger moves with it in the same commit."
  echo "Run: bash scripts/comment-markers.sh --update"
  printf '%s\n' "$delta"
  exit 1
fi
echo "process-marker ratchet: OK ($(wc -l < "$DEBT" | tr -d ' ') files carrying debt)"
