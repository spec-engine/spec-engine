#!/usr/bin/env bash
# spec init installs the agent surface into a member of a fixture copy, and a re-run writes nothing.
source "$(dirname "$0")/_lib.sh"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
cp -R "$FIXTURE" "$TMP/platform"
rm -rf "$TMP/platform/.spec-engine"
API="$TMP/platform/api"
mkdir -p "$API/.githooks"
"$SPEC" init "$API" --json > "$TMP/first.json"
for f in AGENTS.md .claude/skills/req-author/SKILL.md .mcp.json .githooks/pre-commit; do
  test -f "$API/$f" || fail "spec init did not write $f"
done
test "$(jq -r '.agent_surface | length' "$TMP/first.json")" = 4 || fail "agent_surface should list 4 files: $(cat "$TMP/first.json")"
grep -q 'spec-engine:agent-reference:begin' "$API/AGENTS.md" || fail "AGENTS.md has no agent-reference block"
test "$(jq -r '.mcpServers.spec.args[1]' "$API/.mcp.json")" = ".." || fail ".mcp.json spec entry does not point at the platform"
test -x "$API/.githooks/pre-commit" || fail "pre-commit hook is not executable"
BEFORE=$(cd "$API" && find . -type f -print0 | sort -z | xargs -0 shasum)
"$SPEC" init "$API" --json > "$TMP/second.json"
test "$(jq -c '.agent_surface' "$TMP/second.json")" = "[]" || fail "re-run wrote files: $(cat "$TMP/second.json")"
expect_same "spec init re-run changed a file" "$(cd "$API" && find . -type f -print0 | sort -z | xargs -0 shasum)" "$BEFORE"
echo "smoke 28: agent surface installed, re-run is a no-op: OK"
