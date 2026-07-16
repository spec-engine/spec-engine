#!/usr/bin/env bash
#
# scripts/arch-fences.sh — the architecture fences, single source of truth (2.1).
#
# These pure source-grep invariants used to be ~360 lines of bash duplicated
# between the darwin and linux CI jobs (every edit had to happen twice or the
# runners silently diverged). They now live here ONCE, are run by
# `packages/engine/test/architecture-fences.test.ts` (so `bun test` executes
# them on every platform, pre-push, and in CI), and are debuggable locally:
#
#     bash scripts/arch-fences.sh
#
# Each fence is a function whose BODY is verbatim the CI step it replaced,
# including its positive/negative self-tests — so a regressed pattern still
# fails loudly rather than becoming a silent no-op. Each is invoked in a
# subshell (`run`) so a fence's own `exit 1` aborts only that fence, not the
# whole script; the runner tallies failures and exits non-zero if any tripped.
#
# The compiled-binary SMOKES stay in ci.yml — they need the real `dist/spec`
# artifact and the macOS runner, and are not pure source greps.

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

# --- D-11: bun:sqlite outside packages/engine ---------------------------------
fence_d11_bun_sqlite() {
  # Match both double-quote and single-quote import shapes so Biome's
  # default formatter (or a hand-typed single-quote import in a new
  # file) cannot silently bypass the D-11 fence.
  if grep -REn '(from[[:space:]]+["'"'"']bun:sqlite["'"'"']|require\([[:space:]]*["'"'"']bun:sqlite["'"'"'][[:space:]]*\))' packages/shared/src packages/webapp/src; then
    echo "FORBIDDEN: bun:sqlite imported outside packages/engine"
    exit 1
  fi
}

# --- D-08: only storage/sqlite.ts may import bun:sqlite -----------------------
fence_d08_engine_internal() {
  OFFENDERS=$(find packages/engine/src -name '*.ts' -type f \
    | grep -v 'storage/sqlite.ts' \
    | xargs grep -lE '(from[[:space:]]+["'"'"']bun:sqlite["'"'"']|require\([[:space:]]*["'"'"']bun:sqlite["'"'"'][[:space:]]*\))' 2>/dev/null || true)
  if [ -n "$OFFENDERS" ]; then
    echo "FORBIDDEN: bun:sqlite outside storage/sqlite.ts: $OFFENDERS"
    exit 1
  fi
}

# --- SCHM-07: no CHECK/FK/UNIQUE on domain fields ----------------------------
fence_schm07_schema_constraint() {
  if grep -E '(CHECK\(|FOREIGN KEY|^\s*UNIQUE\()' packages/shared/src/schema.ts; then
    echo "FORBIDDEN: schema.ts contains CHECK/FK/UNIQUE constraints (D-03 / Pitfall 5)"
    exit 1
  fi
}

# --- SCHM-08: DDL must be inline TS strings (no .sql files) -------------------
fence_schm08_no_sql_files() {
  if find packages -name '*.sql' -type f | grep -q .; then
    echo "FORBIDDEN: .sql files in packages/ (DDL must be inline TS strings per D-05)"
    exit 1
  fi
}

# --- PROV-02 / SC3: issue_id is never an identity construct ------------------
fence_prov02_issue_id_opacity() {
  PAT='(PRIMARY KEY[^,]*issue_id|issue_id[^,]*PRIMARY KEY|FOREIGN KEY[^)]*issue_id|issue_id[^)]*FOREIGN KEY|UNIQUE\([^)]*issue_id|CREATE[[:space:]]+(UNIQUE[[:space:]]+)?INDEX[^;]*\([^)]*issue_id|JOIN[^;]*ON[^;]*issue_id|GROUP BY[^;]*issue_id)'
  OFFENDERS=$(cat packages/shared/src/schema.ts packages/engine/src/storage/sqlite.ts \
    | grep -vE '^[[:space:]]*(--|//)' \
    | grep -nE "$PAT" || true)
  if [ -n "$OFFENDERS" ]; then
    echo "FORBIDDEN: issue_id appears in an identity construct (PROV-02 / SC3)"
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

# --- DOCS-01: README references spec init + NO_SPEC_CONFIG --------------------
fence_docs01_readme_tokens() {
  set -euo pipefail
  grep -q 'spec init' README.md         || { echo "FAIL: README.md missing 'spec init' token";        exit 1; }
  grep -q 'NO_SPEC_CONFIG' README.md    || { echo "FAIL: README.md missing 'NO_SPEC_CONFIG' token";   exit 1; }
  echo "docs grep gate: OK"
}

# --- MA-4: README + AGENTS.md describe the v1.3 model / migrate / trusted-red -
fence_ma4_v13_doc_reference() {
  set -euo pipefail
  TOKENS='SPEC.json|spec migrate|trusted-red|--results'
  IFS='|'
  for tok in $TOKENS; do
    grep -qF -- "$tok" README.md      || { echo "FAIL: README.md missing '$tok' token (MA-4 v1.3 doc gate)";      exit 1; }
    grep -qF -- "$tok" AGENTS.md || { echo "FAIL: AGENTS.md missing '$tok' token (MA-4 v1.3 doc gate)"; exit 1; }
  done
  unset IFS
  printf 'the trusted-red gate ingests --results <junit.xml>\n' \
    | grep -qF -- 'trusted-red' \
    || { echo "FAIL: v1.3 doc-gate positive self-test did not trip — matcher is broken"; exit 1; }
  if printf 'this line mentions coverage but not the gate token\n' \
    | grep -qF -- 'trusted-red'; then
    echo "FAIL: v1.3 doc-gate negative self-test tripped — matcher is always-true"
    exit 1
  fi
  echo "v1.3 doc-reference gate: OK (all tokens in both docs; self-tests: positive tripped, negative clean)"
}

# --- CLEAN-01: spec-engine.config.example.json must stay deleted --------------
fence_clean01_no_stale_example() {
  if find . -name 'spec-engine.config.example.json' -not -path './node_modules/*' | grep -q .; then
    echo "FORBIDDEN: spec-engine.config.example.json found in tree — spec init is the replacement (CLEAN-01)"
    find . -name 'spec-engine.config.example.json' -not -path './node_modules/*'
    exit 1
  fi
}

# --- TRK-02: engine internals never import @spec-engine/tracker / no ext net --
fence_trk02_tracker_import() {
  INTERNAL_FILES=$(find packages/engine/src -name '*.ts' -type f \
    -not -path 'packages/engine/src/commands/*' \
    -not -path 'packages/engine/src/server/*' \
    -not -path 'packages/engine/src/provenance/resolve.ts')
  if [ -n "$INTERNAL_FILES" ] && echo "$INTERNAL_FILES" | tr '\n' '\0' \
    | xargs -0 grep -REn '(from[[:space:]]+["'"'"']@spec-engine/tracker(/[^"'"'"']*)?["'"'"']|require\([[:space:]]*["'"'"']@spec-engine/tracker)'; then
    echo "FORBIDDEN: packages/engine/src INTERNALS import @spec-engine/tracker (TRK-02 import edge — surface commands/+server/ excluded by design, Phase 16)"
    exit 1
  fi
  HOSTS=$(find packages/engine/src -name '*.ts' -type f -print0 \
    | xargs -0 cat 2>/dev/null \
    | grep -vE '^[[:space:]]*(//|\*|--)' \
    | grep -E 'https?://' \
    | grep -vE '127\.0\.0\.1|localhost' || true)
  if [ -n "$HOSTS" ]; then
    echo "FORBIDDEN: external http(s) host literal in packages/engine/src (TRK-02 no-external-net)"
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

# --- AUTHOR-003: the engine stays LLM-free (no model SDK / inference call) ----
fence_llmfree_engine() {
  # Mirror fence_trk02's host-literal scan: cat every engine source, STRIP
  # comment lines (a header comment naming a token must not self-trip the
  # fence), then grep the model-SDK / inference token set. Covers the major
  # providers (OpenAI, Anthropic, Google Gemini/Vertex, AWS Bedrock, Cohere,
  # Mistral, Groq, HuggingFace, Replicate, Ollama), the common orchestration
  # libs (LangChain, LlamaIndex, Vercel ai-sdk) and the well-known call forms
  # (.chat.completions, generateText/generateObject/streamText). The engine is
  # a static-template front-end — the CLIENT's model runs the prompt; no model
  # logic lives here. (Verified 2026-07-08: none of these tokens false-positive
  # on the current engine source.)
  LLM_PAT='openai|anthropic|@ai-sdk|langchain|llamaindex|ollama|gemini|generativeai|@google/genai|vertexai|bedrock|cohere|mistral|groq|huggingface|replicate|\.chat\.completions|generateText|generateObject|streamText'
  OFFENDERS=$(find packages/engine/src -name '*.ts' -type f -print0 \
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

# --- TRK-04: query only, never a GraphQL mutation ----------------------------
fence_trk04_no_mutation() {
  MUT=$(find packages/tracker/src -name '*.ts' -type f -print0 \
    | xargs -0 cat 2>/dev/null \
    | grep -vE '^[[:space:]]*(//|\*|--)' \
    | grep -nwE 'mutation' || true)
  if [ -n "$MUT" ]; then
    echo "FORBIDDEN: GraphQL mutation in @spec-engine/tracker (TRK-04 one-way truth — query only)"
    echo "$MUT"
    exit 1
  fi
  printf 'mutation { issueCreate { id } }\n' | grep -qwE 'mutation' \
    || { echo "FAIL: no-mutation fence self-test did not trip"; exit 1; }
  echo "tracker no-mutation fence: OK (read-only; self-test tripped)"
}

# --- TRK-06: SPEC_TRACKER_TOKEN never logged ---------------------------------
fence_trk06_no_token_log() {
  OFFENDERS=$(grep -REn 'console\.[a-z]+\([^)]*(SPEC_TRACKER_TOKEN|token)' packages/tracker/src 2>/dev/null || true)
  if [ -n "$OFFENDERS" ]; then
    echo "FORBIDDEN: token referenced in a console.* call in @spec-engine/tracker (TRK-06)"
    echo "$OFFENDERS"
    exit 1
  fi
  printf 'console.log(SPEC_TRACKER_TOKEN)\n' \
    | grep -qE 'console\.[a-z]+\([^)]*SPEC_TRACKER_TOKEN' \
    || { echo "FAIL: no-token-log fence self-test did not trip"; exit 1; }
  echo "no-token-log fence: OK (no token in console.*; self-test tripped)"
}

# --- VAL-01: no direct domain-file write outside validateAndWrite ------------
fence_val01_validate_and_write() {
  PAT='(Bun\.write|writeFile)\([[:space:]]*([A-Za-z0-9_]*([Ss]pecPath|SpecPath)[A-Za-z0-9_]*|(["'"'"'][^"'"'"']*)?SPEC\.json)'
  OFFENDERS=$(find packages/engine/src -name '*.ts' -type f -print0 \
    | xargs -0 cat 2>/dev/null \
    | grep -vE '^[[:space:]]*(//|\*|--)' \
    | grep -nE "$PAT" || true)
  if [ -n "$OFFENDERS" ]; then
    echo "FORBIDDEN: domain spec file written outside validateAndWrite (VAL-01)"
    echo "$OFFENDERS"
    exit 1
  fi
  SELFTEST=$(printf '    await Bun.write(specPath, serialized);\n' \
    | grep -vE '^[[:space:]]*(//|\*|--)' \
    | grep -nE "$PAT" || true)
  if [ -z "$SELFTEST" ]; then
    echo "FAIL: VAL-01 fence self-test did not trip — pattern misses variable-path domain writes"
    exit 1
  fi
  NEGTEST=$(printf '    await Bun.write(doctorPath, renderDoctorMd(x));\n' \
    | grep -vE '^[[:space:]]*(//|\*|--)' \
    | grep -nE "$PAT" || true)
  if [ -n "$NEGTEST" ]; then
    echo "FAIL: VAL-01 fence over-broad — it flagged the sanctioned doctor.md write"
    exit 1
  fi
  echo "VAL-01 fence: OK (fence green; positive self-test tripped; negative self-test clean)"
}

# --- STOR-04 / D2: the Markdown SPEC.md parse path stays removed --------------
fence_stor04_no_spec_md_parse() {
  PAT='(parseSpecFile|findSpecFiles)\(|\*\*/SPEC\.md|gray-matter|(Bun\.file|readFileSync|readFile|Bun\.Glob)\([^)]*SPEC\.md'
  OFFENDERS=$(find packages/engine/src -name '*.ts' -type f -print0 \
    | xargs -0 cat 2>/dev/null \
    | grep -vE '^[[:space:]]*(//|\*|--)' \
    | grep -nE "$PAT" || true)
  if [ -n "$OFFENDERS" ]; then
    echo "FORBIDDEN: SPEC.md parse path reintroduced (STOR-04 / D2)"
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
    echo "FORBIDDEN: gray-matter reintroduced into packages/engine (STOR-04 / D2)"
    echo "$GM"
    exit 1
  fi
  echo "no-SPEC.md-parse fence: OK (fence green; positive self-test tripped; negative self-test clean)"
}

# --- TERM-06 (CHCK-006): committed GLOSSARY.md == generated from the TERM store -
# The human-view drift gate. `spec glossary --check` regenerates GLOSSARY.md from
# spec-engine/TERM/SPEC.json (a deterministic, LLM-free projection) into a buffer
# and diffs it byte-for-byte against the committed file — exit 1 on any drift. So
# a hand-edit of GLOSSARY.md that the store did not produce fails CI here, the same
# way docs-agents.test.ts fails when the CLI surface and AGENTS.md disagree.
# @spec CHCK-006
fence_glossary_roundtrip() {
  if bun packages/engine/src/cli.ts glossary --check .; then
    echo "glossary round-trip fence: OK (committed GLOSSARY.md == generated from the TERM store)"
  else
    echo "FORBIDDEN: committed GLOSSARY.md drifted from the TERM store (run \`spec glossary .\` to regenerate)"
    exit 1
  fi
}

# --- SCHM-008: a requirement (non-TERM) domain carries NO authored specVersion -
# The domain version is the DAG-derived projection (SCHM-007); an authored
# counter beside it could be hand-edited to disagree with the supersede history,
# so the corpus is gated to forbid one. The reserved TERM domain is the sole
# carrier (its counter is the term-drift pin). A requirement never holds a
# top-level `specVersion` (it uses changedAtVersion / supersededAtVersion), so a
# match in a non-TERM SPEC.json is always the envelope counter.
# @spec SCHM-008
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
    echo "FORBIDDEN: authored specVersion on a requirement (non-TERM) domain — the version is derived from the supersede DAG (SCHM-007/008); only the reserved TERM domain carries one. Offending file(s):"
    printf '%s' "$offenders"
    exit 1
  fi
  echo "authored-specVersion fence: OK (no non-TERM envelope carries a counter)"
}

run "D-11 bun:sqlite outside engine"        fence_d11_bun_sqlite
run "D-08 engine-internal bun:sqlite"       fence_d08_engine_internal
run "SCHM-07 schema-constraint"             fence_schm07_schema_constraint
run "SCHM-08 no .sql files"                 fence_schm08_no_sql_files
run "PROV-02 issue_id opacity"              fence_prov02_issue_id_opacity
run "DOCS-01 README tokens"                 fence_docs01_readme_tokens
run "MA-4 v1.3 doc-reference"               fence_ma4_v13_doc_reference
run "CLEAN-01 no stale example config"      fence_clean01_no_stale_example
run "TRK-02 tracker import edge"            fence_trk02_tracker_import
run "TRK-04 no GraphQL mutation"            fence_trk04_no_mutation
run "TRK-06 no token log"                   fence_trk06_no_token_log
run "VAL-01 validateAndWrite seam"          fence_val01_validate_and_write
run "STOR-04 no SPEC.md parse path"         fence_stor04_no_spec_md_parse
run "AUTHOR-003 llm-free engine"            fence_llmfree_engine
run "TERM-06 glossary round-trip"           fence_glossary_roundtrip
run "SCHM-008 no authored specVersion"      fence_no_authored_specversion

if [ "$fail" -ne 0 ]; then
  echo ""
  echo "One or more architecture fences failed."
  exit 1
fi
echo ""
echo "All architecture fences green."
