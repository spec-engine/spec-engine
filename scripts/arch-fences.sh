#!/usr/bin/env bash
#
# scripts/arch-fences.sh — the architecture fences, single source of truth.
#
# Pure source-grep invariants, each stated once here and run by
# `packages/engine/test/architecture-fences.test.ts` (so `bun test` executes
# them on every platform, pre-push, and in CI), and debuggable locally:
#
#     bash scripts/arch-fences.sh
#
# Each fence is a function carrying the `@spec` tag of the requirement it
# enforces; its `run` label starts with that id. A fence includes its own
# positive/negative self-tests, so a regressed pattern still fails loudly
# rather than becoming a silent no-op. Each is invoked in a subshell (`run`)
# so a fence's own `exit 1` aborts only that fence, not the whole script; the
# runner tallies failures and exits non-zero if any tripped.
#
# The compiled-binary SMOKES live in scripts/smoke/ — they need the real
# `dist/spec` artifact and are not pure source greps.

set -uo pipefail
cd "$(dirname "$0")/.."   # repo root — every fence path is repo-root-relative

fail=0
run() {
  local name="$1"; shift
  echo "── fence: ${name}"
  if ( "$@" ); then
    :
  else
    echo "‼️  FENCE FAILED: ${name}"
    fail=1
  fi
}

# --- SCHM-025: bun:sqlite outside packages/engine --------------------------
# @spec SCHM-025
fence_d11_bun_sqlite() {
  # Match both double-quote and single-quote import shapes so Biome's
  # default formatter (or a hand-typed single-quote import in a new
  # file) cannot silently bypass the fence.
  if grep -REn --exclude='*.test.ts' '(from[[:space:]]+["'"'"']bun:sqlite["'"'"']|require\([[:space:]]*["'"'"']bun:sqlite["'"'"'][[:space:]]*\))' packages/shared/src packages/webapp/src; then
    echo "FORBIDDEN: bun:sqlite imported outside packages/engine"
    exit 1
  fi
}

# Production engine source: everything under packages/engine/src except the
# co-located tests (`*.test.ts`) and the test helpers and planted trees under
# src/testing/. Every engine fence enumerates through this one function.
engine_sources() {
  find packages/engine/src -name '*.ts' -type f -not -name '*.test.ts' -not -path '*/src/testing/*' "$@"
}

# --- SCHM-025: only storage/sqlite.ts may import bun:sqlite ----------------
# @spec SCHM-025
fence_d08_engine_internal() {
  OFFENDERS=$(engine_sources \
    | grep -v 'storage/sqlite.ts' \
    | xargs grep -lE '(from[[:space:]]+["'"'"']bun:sqlite["'"'"']|require\([[:space:]]*["'"'"']bun:sqlite["'"'"'][[:space:]]*\))' 2>/dev/null || true)
  if [ -n "$OFFENDERS" ]; then
    echo "FORBIDDEN: bun:sqlite outside storage/sqlite.ts: $OFFENDERS"
    exit 1
  fi
}

# --- SCHM-027: the write seam belongs to the operations layer --------------
# An HTTP route, an MCP tool, or a command may parse, call an operation, and
# render. None of them may write a domain file or allocate an id itself: the
# write seam and the id allocator are imported only under operations/.
# @spec SCHM-027
fence_ops01_write_seam() {
  OFFENDERS=$(grep -RlE --exclude='*.test.ts' 'validateAndWrite|nextRequirementId' packages/engine/src/server packages/engine/src/commands 2>/dev/null || true)
  if [ -n "$OFFENDERS" ]; then
    echo "FORBIDDEN: a surface reaches the write seam directly instead of an operation (SCHM-027): $OFFENDERS"
    exit 1
  fi
}

# --- SCHM-030: a SPEC.json is read only through the shared schema ----------
# JSON.parse lives where a file's own schema lives: the domain reader in
# shared, the member-config and package.json readers, and the HTTP body
# reader. Nothing in production source casts through `unknown`.
# @spec SCHM-030
fence_schm030_schema_reads() {
  ALLOWED='packages/shared/src/domain.ts|packages/engine/src/indexer/discover.ts|packages/engine/src/operations/init.ts|packages/engine/src/server/api.ts'
  OFFENDERS=$(grep -RnE --include='*.ts' --exclude='*.test.ts' --exclude-dir=testing 'JSON\.parse\(|as unknown as' packages/*/src 2>/dev/null \
    | awk -F: -v allowed="^($ALLOWED)$" '$0 ~ /as unknown as/ || $1 !~ allowed' || true)
  if [ -n "$OFFENDERS" ]; then
    echo "FORBIDDEN: a SPEC.json read outside the shared schema, or a cast through unknown (SCHM-030):"
    echo "$OFFENDERS"
    exit 1
  fi
}

# --- INIT-037: platform-map's map() and locate() enter through discover.ts --
# Membership and shape have one reader in the engine. operations/init.ts may
# import the write half (planInit, applyInit, planLink, applyLink) and the
# pure probes (detect, discover); nothing else in production source imports
# the package at all.
# @spec INIT-037
fence_init037_platform_map_seam() {
  local importers readers
  importers=$(engine_sources | xargs grep -lE 'from "@spec-engine/platform-map"' 2>/dev/null | sort)
  expected=$(printf '%s\n' packages/engine/src/indexer/discover.ts packages/engine/src/operations/init.ts)
  if [ "$importers" != "$expected" ]; then
    echo "FORBIDDEN: @spec-engine/platform-map is imported outside indexer/discover.ts and operations/init.ts:"
    diff <(printf '%s\n' "$expected") <(printf '%s\n' "$importers") || true
    exit 1
  fi
  # The read half (map, locate) is imported in discover.ts only. The import
  # statement spans lines, so the specifier list is matched on the joined file.
  readers=$(for f in $importers; do
    perl -0777 -ne 'while (/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*"\@spec-engine\/platform-map"/g) { print "HIT\n" if $1 =~ /(^|[\s,])(map|locate)\s*(,|$)/m; }' "$f" \
      | grep -q HIT && echo "$f"
  done)
  if [ "$readers" != "packages/engine/src/indexer/discover.ts" ]; then
    echo "FORBIDDEN: map()/locate() from platform-map imported outside indexer/discover.ts (or the reader pattern no longer matches discover.ts): ${readers:-<none>}"
    exit 1
  fi
  echo "platform-map seam fence: OK (readers: discover.ts; writers: operations/init.ts)"
}

# --- SCHM-028: no CHECK/FK/UNIQUE on domain fields -------------------------
# @spec SCHM-028
fence_schm07_schema_constraint() {
  if grep -E '(CHECK\(|FOREIGN KEY|^\s*UNIQUE\()' packages/shared/src/schema.ts; then
    echo "FORBIDDEN: schema.ts contains CHECK/FK/UNIQUE constraints (SCHM-028)"
    exit 1
  fi
}

# --- SCHM-029: DDL must be inline TS strings (no .sql files) ---------------
# @spec SCHM-029
fence_schm08_no_sql_files() {
  if find packages -name '*.sql' -type f | grep -q .; then
    echo "FORBIDDEN: .sql files in packages/ (DDL must be inline TS strings, SCHM-029)"
    exit 1
  fi
}

# --- PROV-004: issue_id is never an identity construct ---------------------
# @spec PROV-004
fence_prov02_issue_id_opacity() {
  PAT='(PRIMARY KEY[^,]*issue_id|issue_id[^,]*PRIMARY KEY|FOREIGN KEY[^)]*issue_id|issue_id[^)]*FOREIGN KEY|UNIQUE\([^)]*issue_id|CREATE[[:space:]]+(UNIQUE[[:space:]]+)?INDEX[^;]*\([^)]*issue_id|JOIN[^;]*ON[^;]*issue_id|GROUP BY[^;]*issue_id)'
  OFFENDERS=$(cat packages/shared/src/schema.ts packages/engine/src/storage/sqlite.ts \
    | grep -vE '^[[:space:]]*(--|//)' \
    | grep -nE "$PAT" || true)
  if [ -n "$OFFENDERS" ]; then
    echo "FORBIDDEN: issue_id appears in an identity construct (PROV-004)"
    echo "$OFFENDERS"
    exit 1
  fi
  SELFTEST=$(printf 'CREATE INDEX idx_selftest ON provenance(issue_id);\n' \
    | grep -nE "$PAT" || true)
  if [ -z "$SELFTEST" ]; then
    echo "FAIL: issue_id-opacity fence self-test did not trip — pattern is broken"
    exit 1
  fi
  SELFTEST_UNIQUE=$(printf 'CREATE UNIQUE INDEX idx_selftest ON provenance(issue_id);\n' \
    | grep -nE "$PAT" || true)
  if [ -z "$SELFTEST_UNIQUE" ]; then
    echo "FAIL: issue_id-opacity fence UNIQUE self-test did not trip — UNIQUE form regressed"
    exit 1
  fi
  echo "issue_id-opacity gate: OK (fence green; self-tests tripped)"
}

# --- DIST-012: README references spec init + NO_SPEC_CONFIG ----------------
# @spec DIST-012
fence_docs01_readme_tokens() {
  set -euo pipefail
  grep -q 'spec init' README.md         || { echo "FAIL: README.md missing 'spec init' token";        exit 1; }
  grep -q 'NO_SPEC_CONFIG' README.md    || { echo "FAIL: README.md missing 'NO_SPEC_CONFIG' token";   exit 1; }
  echo "docs grep gate: OK"
}

# --- DIST-013: README + AGENTS.md describe the JSON model / migrate / trusted-red
# @spec DIST-013
fence_ma4_v13_doc_reference() {
  set -euo pipefail
  TOKENS='SPEC.json|spec migrate|trusted-red|--results'
  IFS='|'
  for tok in $TOKENS; do
    grep -qF -- "$tok" README.md      || { echo "FAIL: README.md missing '$tok' token (DIST-013 doc gate)";      exit 1; }
    grep -qF -- "$tok" AGENTS.md || { echo "FAIL: AGENTS.md missing '$tok' token (DIST-013 doc gate)"; exit 1; }
  done
  unset IFS
  printf 'the trusted-red gate ingests --results <junit.xml>\n' \
    | grep -qF -- 'trusted-red' \
    || { echo "FAIL: doc-gate positive self-test did not trip — matcher is broken"; exit 1; }
  if printf 'this line mentions coverage but not the gate token\n' \
    | grep -qF -- 'trusted-red'; then
    echo "FAIL: doc-gate negative self-test tripped — matcher is always-true"
    exit 1
  fi
  echo "doc-reference gate: OK (all tokens in both docs; self-tests: positive tripped, negative clean)"
}

# --- DIST-014: spec-engine.config.example.json must stay deleted -----------
# @spec DIST-014
fence_clean01_no_stale_example() {
  if find . -name 'spec-engine.config.example.json' -not -path './node_modules/*' | grep -q .; then
    echo "FORBIDDEN: spec-engine.config.example.json found in tree — spec init is the replacement (DIST-014)"
    find . -name 'spec-engine.config.example.json' -not -path './node_modules/*'
    exit 1
  fi
}

# --- TRK-004: engine internals never import @spec-engine/tracker / no ext net
# @spec TRK-004
fence_trk02_tracker_import() {
  INTERNAL_FILES=$(engine_sources \
    -not -path 'packages/engine/src/commands/*' \
    -not -path 'packages/engine/src/server/*' \
    -not -path 'packages/engine/src/provenance/resolve.ts')
  if [ -n "$INTERNAL_FILES" ] && echo "$INTERNAL_FILES" | tr '\n' '\0' \
    | xargs -0 grep -REn '(from[[:space:]]+["'"'"']@spec-engine/tracker(/[^"'"'"']*)?["'"'"']|require\([[:space:]]*["'"'"']@spec-engine/tracker)'; then
    echo "FORBIDDEN: packages/engine/src INTERNALS import @spec-engine/tracker (TRK-004 import edge — the surfaces commands/ and server/ are excluded by design)"
    exit 1
  fi
  HOSTS=$(engine_sources -print0 \
    | xargs -0 cat 2>/dev/null \
    | grep -vE '^[[:space:]]*(//|\*|--)' \
    | grep -E 'https?://' \
    | grep -vE '127\.0\.0\.1|localhost' || true)
  if [ -n "$HOSTS" ]; then
    echo "FORBIDDEN: external http(s) host literal in packages/engine/src (TRK-004 no-external-net)"
    echo "$HOSTS"
    exit 1
  fi
  echo 'import x from "@spec-engine/tracker"' \
    | grep -qE 'from[[:space:]]+["'"'"']@spec-engine/tracker' \
    || { echo "FAIL: tracker import fence self-test did not trip"; exit 1; }
  printf '    const u = "https://api.linear.app";\n' \
    | grep -vE '^[[:space:]]*(//|\*|--)' \
    | grep -E 'https?://' \
    | grep -vE '127\.0\.0\.1|localhost' \
    | grep -q . \
    || { echo "FAIL: host-literal self-test did not trip — comment-strip over-matched"; exit 1; }
  printf 'packages/engine/src/indexer/pipeline.ts:1:import x from "@spec-engine/tracker"\n' \
    | grep -qE 'packages/engine/src/(indexer|parser|storage|scanner|check)/[^:]*:.*@spec-engine/tracker' \
    || { echo "FAIL: narrowed fence self-test did not trip on an indexer/ import"; exit 1; }
  if echo "$INTERNAL_FILES" | grep -qE 'packages/engine/src/(commands/|server/|provenance/resolve\.ts)'; then
    echo "FAIL: surface exclusion over-pruned / under-pruned (commands/, server/, or provenance/resolve.ts leaked into the guarded internal set)"
    exit 1
  fi
  echo "tracker import fence: OK (surface excluded; internals guarded; indexer/ self-test tripped; no external host; loopback green; self-tests tripped)"
}

# --- AUTHOR-008: the engine stays LLM-free (no model SDK / inference call) --
# @spec AUTHOR-008
fence_llmfree_engine() {
  # Mirror the tracker fence's host-literal scan: cat every engine source,
  # STRIP comment lines (a header comment naming a token must not self-trip
  # the fence), then grep the model-SDK / inference token set. Covers the
  # major providers, the common orchestration libs, and the well-known call
  # forms. The engine is a static-template front-end — the CLIENT's model
  # runs the prompt; no model logic lives here.
  LLM_PAT='openai|anthropic|@ai-sdk|langchain|llamaindex|ollama|gemini|generativeai|@google/genai|vertexai|bedrock|cohere|mistral|groq|huggingface|replicate|\.chat\.completions|generateText|generateObject|streamText'
  OFFENDERS=$(engine_sources -print0 \
    | xargs -0 cat 2>/dev/null \
    | grep -vE '^[[:space:]]*(//|\*|--)' \
    | grep -nE "$LLM_PAT" || true)
  if [ -n "$OFFENDERS" ]; then
    echo "FORBIDDEN: model SDK / inference token in packages/engine/src (fence_llmfree_engine — engine stays LLM-free)"
    echo "$OFFENDERS"
    exit 1
  fi
  # Positive self-test: an injected model import MUST trip the matcher.
  printf 'import OpenAI from "openai";\n' \
    | grep -vE '^[[:space:]]*(//|\*|--)' \
    | grep -qE "$LLM_PAT" \
    || { echo "FAIL: llm-free fence positive self-test did not trip"; exit 1; }
  # Negative self-test: a clean non-model source line must NOT trip.
  if printf 'const x = renderAuthorPrompt(o);\n' \
    | grep -vE '^[[:space:]]*(//|\*|--)' \
    | grep -qE "$LLM_PAT"; then
    echo "FAIL: llm-free fence negative self-test tripped — matcher is always-true"
    exit 1
  fi
  echo "llm-free engine fence: OK (no model SDK/inference in packages/engine/src; self-tests tripped)"
}

# --- TRK-005: query only, never a GraphQL mutation --------------------------
# @spec TRK-005
fence_trk04_no_mutation() {
  MUT=$(find packages/tracker/src -name '*.ts' -type f -not -name '*.test.ts' -print0 \
    | xargs -0 cat 2>/dev/null \
    | grep -vE '^[[:space:]]*(//|\*|--)' \
    | grep -nwE 'mutation' || true)
  if [ -n "$MUT" ]; then
    echo "FORBIDDEN: GraphQL mutation in @spec-engine/tracker (TRK-005 one-way truth — query only)"
    echo "$MUT"
    exit 1
  fi
  printf 'mutation { issueCreate { id } }\n' | grep -qwE 'mutation' \
    || { echo "FAIL: no-mutation fence self-test did not trip"; exit 1; }
  echo "tracker no-mutation fence: OK (read-only; self-test tripped)"
}

# --- TRK-006: SPEC_TRACKER_TOKEN never logged -------------------------------
# @spec TRK-006
fence_trk06_no_token_log() {
  OFFENDERS=$(grep -REn --exclude='*.test.ts' 'console\.[a-z]+\([^)]*(SPEC_TRACKER_TOKEN|token)' packages/tracker/src 2>/dev/null || true)
  if [ -n "$OFFENDERS" ]; then
    echo "FORBIDDEN: token referenced in a console.* call in @spec-engine/tracker (TRK-006)"
    echo "$OFFENDERS"
    exit 1
  fi
  printf 'console.log(SPEC_TRACKER_TOKEN)\n' \
    | grep -qE 'console\.[a-z]+\([^)]*SPEC_TRACKER_TOKEN' \
    || { echo "FAIL: no-token-log fence self-test did not trip"; exit 1; }
  echo "no-token-log fence: OK (no token in console.*; self-test tripped)"
}

# --- SCHM-026: no direct domain-file write outside validateAndWrite --------
# Every source file in every package, the co-located tests and the helpers
# under src/testing/ included. The only exemption is the planted trees under
# src/testing/fixtures/, which are data, not code. A test authors its
# platform through src/testing/platform.ts (the operations) or plants a state
# the engine refuses through src/testing/plant.ts (still the seam).
# @spec SCHM-026
fence_val01_validate_and_write() {
  PAT='(Bun\.write|writeFile|writeFileSync)\([^;]*(SPEC\.json|[Ss]pecPath|[Ss]pecFile)'
  OFFENDERS=$(find packages/*/src -name '*.ts' -type f -not -path '*/src/testing/fixtures/*' -print0 \
    | xargs -0 grep -nHE "$PAT" 2>/dev/null \
    | grep -vE '^[^:]+:[0-9]+:[[:space:]]*(//|\*|--)' || true)
  if [ -n "$OFFENDERS" ]; then
    echo "FORBIDDEN: domain spec file written outside validateAndWrite (SCHM-026)"
    echo "$OFFENDERS"
    exit 1
  fi
  SELFTEST=$(printf '    await Bun.write(specPath, serialized);\n' \
    | grep -vE '^[[:space:]]*(//|\*|--)' \
    | grep -nE "$PAT" || true)
  if [ -z "$SELFTEST" ]; then
    echo "FAIL: SCHM-026 fence self-test did not trip — pattern misses variable-path domain writes"
    exit 1
  fi
  SELFTEST_TEST=$(printf '    writeFileSync(join(root, "spec-engine", key, "SPEC.json"), JSON.stringify(doc));\n' \
    | grep -vE '^[[:space:]]*(//|\*|--)' \
    | grep -nE "$PAT" || true)
  if [ -z "$SELFTEST_TEST" ]; then
    echo "FAIL: SCHM-026 fence self-test did not trip — pattern misses a test's hand-written envelope"
    exit 1
  fi
  NEGTEST=$(printf '    await Bun.write(doctorPath, renderDoctorMd(x));\n    writeFileSync(join(clone, "results.xml"), xml);\n' \
    | grep -vE '^[[:space:]]*(//|\*|--)' \
    | grep -nE "$PAT" || true)
  if [ -n "$NEGTEST" ]; then
    echo "FAIL: SCHM-026 fence over-broad — it flagged a sanctioned non-spec write"
    exit 1
  fi
  echo "validateAndWrite seam fence: OK (fence green over every source and test; self-tests tripped; negative self-test clean)"
}

# --- INDX-013: the Markdown SPEC.md parse path stays removed ---------------
# @spec INDX-013
fence_stor04_no_spec_md_parse() {
  PAT='(parseSpecFile|findSpecFiles)\(|\*\*/SPEC\.md|gray-matter|(Bun\.file|readFileSync|readFile|Bun\.Glob)\([^)]*SPEC\.md'
  OFFENDERS=$(engine_sources -print0 \
    | xargs -0 cat 2>/dev/null \
    | grep -vE '^[[:space:]]*(//|\*|--)' \
    | grep -nE "$PAT" || true)
  if [ -n "$OFFENDERS" ]; then
    echo "FORBIDDEN: SPEC.md parse path reintroduced (INDX-013)"
    echo "$OFFENDERS"
    exit 1
  fi
  SELFTEST=$(printf '    const parsed = parseSpecFile(specPath);\n' \
    | grep -vE '^[[:space:]]*(//|\*|--)' \
    | grep -nE "$PAT" || true)
  if [ -z "$SELFTEST" ]; then
    echo "FAIL: no-SPEC.md-parse fence self-test did not trip — pattern misses a parseSpecFile( call"
    exit 1
  fi
  SELFTEST_READ=$(printf '    const raw = await Bun.file("api/SPEC.md").text();\n' \
    | grep -vE '^[[:space:]]*(//|\*|--)' \
    | grep -nE "$PAT" || true)
  if [ -z "$SELFTEST_READ" ]; then
    echo "FAIL: no-SPEC.md-parse fence self-test did not trip — pattern misses a Bun.file(...SPEC.md) read path"
    exit 1
  fi
  NEGTEST=$(printf '    console.error("refusing to overwrite spec-engine/BILLING/SPEC.md");\n' \
    | grep -vE '^[[:space:]]*(//|\*|--)' \
    | grep -nE "$PAT" || true)
  if [ -n "$NEGTEST" ]; then
    echo "FAIL: no-SPEC.md-parse fence over-broad — it flagged a legitimate SPEC.md string mention"
    exit 1
  fi
  GM=$(grep -rn 'gray-matter' packages/engine || true)
  if [ -n "$GM" ]; then
    echo "FORBIDDEN: gray-matter reintroduced into packages/engine (INDX-013)"
    echo "$GM"
    exit 1
  fi
  echo "no-SPEC.md-parse fence: OK (fence green; positive self-test tripped; negative self-test clean)"
}

# --- CHCK-020: committed GLOSSARY.md == generated from the TERM store -------
# The human-view drift gate. `spec glossary --check` regenerates GLOSSARY.md
# from spec-engine/TERM/SPEC.json (a deterministic, LLM-free projection) into a
# buffer and diffs it byte-for-byte against the committed file — exit 1 on any
# drift. So a hand-edit of GLOSSARY.md that the store did not produce fails CI
# here, the same way docs-agents.test.ts fails when the CLI surface and
# AGENTS.md disagree.
# @spec CHCK-020
fence_glossary_roundtrip() {
  if bun packages/engine/src/cli.ts glossary --check .; then
    echo "glossary round-trip fence: OK (committed GLOSSARY.md == generated from the TERM store)"
  else
    echo "FORBIDDEN: committed GLOSSARY.md drifted from the TERM store (run \`spec glossary .\` to regenerate)"
    exit 1
  fi
}

# --- SCHM-020: a requirement (non-TERM) domain carries NO authored specVersion
# The domain version is the DAG-derived projection; an authored counter beside
# it could be hand-edited to disagree with the supersede history, so the
# corpus is gated to forbid one. The reserved TERM domain is the sole carrier
# (its counter is the term-drift pin). A requirement never holds a top-level
# `specVersion` (it uses changedAtVersion / supersededAtVersion), so a match
# in a non-TERM SPEC.json is always the envelope counter.
# @spec SCHM-020
fence_no_authored_specversion() {
  local offenders=""
  for f in spec-engine/*/SPEC.json; do
    case "$f" in */TERM/SPEC.json) continue ;; esac
    if grep -qE '"specVersion"' "$f"; then
      offenders="${offenders}${f}"$'\n'
    fi
  done
  # Negative self-test: the detector must flag a planted non-TERM offender.
  if ! printf '{ "key": "X", "specVersion": 2 }' | grep -qE '"specVersion"'; then
    echo "FENCE SELF-TEST FAILED: specVersion detector no longer matches"
    exit 1
  fi
  if [ -n "$offenders" ]; then
    echo "FORBIDDEN: authored specVersion on a requirement (non-TERM) domain — the version is derived from the supersede DAG; only the reserved TERM domain carries one. Offending file(s):"
    printf '%s' "$offenders"
    exit 1
  fi
  echo "authored-specVersion fence: OK (no non-TERM envelope carries a counter)"
}

# --- CHCK-030: the AGENTS.md diagnostic-code list matches the DiagnosticCode enum
# The list is hand-written prose beside a machine-readable enum, so it drifts.
# This compares the two sets (order and duplicates are prose's business,
# membership is not).
# @spec CHCK-030
fence_agents_check_codes() {
  local enum_codes agents_codes
  enum_codes="$(grep -oE '^  [A-Z_]+: "' packages/shared/src/diagnostics.ts \
    | sed -E 's/^  ([A-Z_]+): "$/\1/' | sort -u)"
  # The code list lives in the `spec check` bullet, between "Codes," and the
  # sentence that follows it. Every code is fenced in backticks.
  # shellcheck disable=SC2016
  agents_codes="$(sed -n '/Codes, in `DiagnosticCode` order:/,/The four/p' AGENTS.md \
    | grep -oE '`[A-Z_]+`' | tr -d '`' | sort -u)"
  # Negative self-test: the extractor must find something on both sides.
  if [ -z "$enum_codes" ] || [ -z "$agents_codes" ]; then
    echo "FENCE SELF-TEST FAILED: a code extractor matched nothing"
    exit 1
  fi
  if [ "$enum_codes" != "$agents_codes" ]; then
    echo "FORBIDDEN: the AGENTS.md diagnostic-code list disagrees with the DiagnosticCode enum. Difference (< enum only, > AGENTS.md only):"
    diff <(printf '%s\n' "$enum_codes") <(printf '%s\n' "$agents_codes") || true
    exit 1
  fi
  echo "AGENTS check-codes fence: OK (list == DiagnosticCode enum)"
}

# --- CHRT-007: TAXONOMY.md per-domain charters are generated from the envelopes
# The envelope `scope` is canonical (it ships with adopters and feeds
# `spec domain list` / `spec req`); the document is derived from it.
# @spec CHRT-007
fence_taxonomy_charters() {
  if bun scripts/gen-charters.ts --check; then
    echo "charter generation fence: OK (TAXONOMY.md == envelope scope fields)"
  else
    echo "FORBIDDEN: TAXONOMY.md drifted from the envelope scope fields (run \`bun scripts/gen-charters.ts\`)"
    exit 1
  fi
}

# --- AUTHOR-011: process markers in source comments -------------------------
# A comment naming a plan, phase, wave, pitfall, or review round records how
# the code arrived rather than what constrains it. Files still carry them, so
# this is a ratchet over a ledger rather than a ban: the count can only fall.
# @spec AUTHOR-011
fence_comment_markers() {
  if bash scripts/comment-markers.sh; then
    :
  else
    echo "FORBIDDEN: process markers in source comments (see the comment policy in AGENTS.md)"
    exit 1
  fi
}

run "SCHM-025 bun:sqlite outside the engine"                  fence_d11_bun_sqlite
run "SCHM-025 bun:sqlite outside storage/sqlite.ts"           fence_d08_engine_internal
run "SCHM-028 no CHECK, FK, or UNIQUE on domain fields"        fence_schm07_schema_constraint
run "SCHM-029 DDL inline, no .sql files"                       fence_schm08_no_sql_files
run "PROV-004 issue_id is never an identity"                   fence_prov02_issue_id_opacity
run "DIST-012 README names spec init and NO_SPEC_CONFIG"       fence_docs01_readme_tokens
run "DIST-013 README and AGENTS.md name the JSON model and the proof gate" fence_ma4_v13_doc_reference
run "DIST-014 no stale example config"                         fence_clean01_no_stale_example
run "TRK-004 engine internals never import the tracker or reach the network" fence_trk02_tracker_import
run "TRK-005 tracker sends queries only"                       fence_trk04_no_mutation
run "TRK-006 token never logged"                               fence_trk06_no_token_log
run "SCHM-026 every SPEC.json write goes through validateAndWrite" fence_val01_validate_and_write
run "INDX-013 no SPEC.md parse path"                           fence_stor04_no_spec_md_parse
run "AUTHOR-008 llm-free engine"                               fence_llmfree_engine
run "CHCK-020 glossary round-trip"                             fence_glossary_roundtrip
run "SCHM-020 no authored specVersion"                         fence_no_authored_specversion
run "CHCK-030 AGENTS.md lists every diagnostic code"           fence_agents_check_codes
run "CHRT-007 charters generated from the envelopes"           fence_taxonomy_charters
run "AUTHOR-011 process-marker ratchet"                        fence_comment_markers
run "SCHM-027 write seam under operations"                     fence_ops01_write_seam
run "SCHM-030 every SPEC.json read parses through the shared schema" fence_schm030_schema_reads
run "INIT-037 platform-map map() and locate() enter through discover.ts" fence_init037_platform_map_seam

if [ "$fail" -ne 0 ]; then
  echo ""
  echo "One or more architecture fences failed."
  exit 1
fi
echo ""
echo "All architecture fences green."
