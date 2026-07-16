// packages/engine/src/commands/provenance.ts
//
// PMAT-01 / PMAT-02: `spec provenance [platformDir] [--out <path>] [--json]`
// — citty subcommand that renders the per-requirement provenance matrix:
// each requirement's creating issue, its revising/retiring issues
// (supersedes-via / amends-via), the backing tests, and the git pointer
// (source_file:line). `--json` emits the deterministically-sorted
// ProvenanceMatrixRow[] (full composite-key sort, no chrome) instead.
//
// Behavior mirrors commands/relations.ts (read-only command conventions):
//   - Never exits non-zero on the data itself. Bad args or
//     path-containment violations exit 2.
//   - If `dbPath` does not exist (or the index is empty — D-12
//     silent-rebuild case), transparently runIndex.
//   - Output is delegated to provenance/format.ts (pure formatter) — the
//     SAME formatter the Phase 16 webapp will render through, so the CLI
//     and webapp surfaces cannot drift (one engine, not two).
//
// PMAT-03: an OPTIONAL leading positional `<ISSUE-ID>` performs a
// display-only reverse lookup — when present the matrix is filtered to the
// requirements a given opaque issue is linked to via
// storage.provenanceByIssue() (a bound `$issue` param, Plan 01); when absent
// the command renders the full matrix (storage.provenanceMatrix()). The
// ISSUE-ID is a filter VALUE only — never a routing/resolve/coverage/join key
// — so the Phase 12 issue_id-opacity grep-fence stays green.
//
// V12 path-containment: `--out` must resolve under platformDir — same
// guard as commands/check.ts / commands/relations.ts.
//
// D-08 grep-fence: this file does NOT import bun:sqlite. DB access goes
// exclusively through the Storage interface from @spec-engine/shared.

import { statSync } from "node:fs";
import { resolve } from "node:path";
import { defineCommand } from "citty";
import { OUT_HELP, resolveDbPath } from "../constants";
import { maybePromptForOnboarding } from "../onboarding/prompt";
import { renderProvenance, renderProvenanceDecorated } from "../provenance/format";
import { resolveAndCache } from "../provenance/resolve";
import { assertContainedPath, withReadStorage } from "./_shared";

/** B.1-style empty-state message (stderr, exit 0) — provenance-specific:
 *  an indexed platform with requirements but no `**Issues:** …` provenance
 *  fields is a legitimate empty matrix, not an error. */
function formatNoProvenance(platformDir: string): string {
  return [
    `No provenance links indexed under ${platformDir}.`,
    `Add an "**Issues:** created:ENG-NNNN" line to a requirement in spec-engine/<KEY>/SPEC.md, then re-run \`spec index\`.`,
  ].join("\n");
}

/** Reverse-lookup empty-state message (stderr, exit 0): a reverse lookup for
 *  an opaque issue id with no matching links is a legitimate empty result,
 *  not an error. issue_id is rendered verbatim — never resolved as a key. */
function formatNoProvenanceForIssue(issueId: string, platformDir: string): string {
  return `No provenance links for ${issueId} indexed under ${platformDir}.`;
}

export const provenanceCommand = defineCommand({
  meta: {
    name: "provenance",
    description:
      "Render the per-requirement provenance matrix (creating/revising issues + backing tests + git pointer). --json emits the deterministically-sorted matrix rows.",
  },
  args: {
    // PMAT-03: OPTIONAL leading positional. Declared BEFORE platformDir so
    // citty (which orders positionals by declaration) parses the issue id
    // first: `spec provenance ENG-1432 fixtures/...`. issue_id is a filter
    // VALUE only — it flows solely into the bound `$issue` param of
    // provenanceByIssue(), never into a route/resolve/coverage/join key.
    issueId: {
      type: "positional",
      required: false,
      description: "Opaque issue id to reverse-lookup, e.g., ENG-1432",
    },
    platformDir: {
      type: "positional",
      required: false,
      description: "Platform directory containing spec-engine/ + members (default: cwd)",
    },
    out: {
      type: "string",
      description: OUT_HELP,
    },
    json: {
      type: "boolean",
      description:
        "Emit provenance matrix rows as a JSON array (deterministically sorted, no chrome)",
    },
    // Phase 16 (PWEB-02): opt-in tracker overlay. NO default — absence means OFF,
    // so without the flag the render path is byte-identical to Phase 13 (the
    // existing renderProvenance line below). When present, the matrix is rendered
    // through the SHARED decorator after resolving + caching via resolveAndCache
    // (the surface seam that imports @spec-engine/tracker; engine internals stay clean).
    resolveIssues: {
      type: "boolean",
      description: "Overlay tracker title/status/url (needs SPEC_TRACKER_TOKEN); off by default",
    },
    fresh: {
      type: "boolean",
      description:
        "Force a cold rebuild of the derived index before reading (rm + reindex; same trio as check --ci)",
    },
    noPrompt: {
      type: "boolean",
      description:
        "Suppress interactive onboarding prompt for siblings missing spec-engine.member.json (defaults to NO_SPEC_CONFIG warning)",
    },
  },
  async run({ args }) {
    // PMAT-03: an empty issueId is the LEGITIMATE full-matrix case — unlike
    // propagation's REQUIRED reqId, we do NOT exit when blank. issue_id is an
    // opaque filter VALUE; it never routes, resolves, or keys anything.
    let issueId = ((args.issueId as string | undefined) ?? "").trim();
    let platformArg = args.platformDir as string | undefined;

    // Positional disambiguation: citty binds a SINGLE positional to the first
    // declared slot (issueId). But `spec provenance <platformDir>` (one arg,
    // a directory) must render the FULL matrix, while `spec provenance
    // <ISSUE-ID> <platformDir>` (two args) is the reverse lookup. When only
    // the leading positional is present and it resolves to an existing
    // DIRECTORY, treat it as platformDir, not an issue id. Issue ids
    // (e.g. ENG-1432) never resolve to a directory, so this is unambiguous —
    // and issue_id stays an opaque VALUE, never a filesystem/route key.
    if (issueId && platformArg === undefined) {
      let isDir = false;
      try {
        isDir = statSync(resolve(issueId)).isDirectory();
      } catch {
        isDir = false;
      }
      if (isDir) {
        platformArg = issueId;
        issueId = "";
      }
    }

    const platformDir = resolve(platformArg ?? process.cwd());
    const outArg = args.out as string | undefined;
    // WR-01: resolve --out relative to platformDir (NOT cwd) — mirrors
    // commands/relations.ts. See check.ts for full rationale.
    const dbPath = resolveDbPath(platformDir, outArg);

    // V12 path-containment guard — mirrors commands/relations.ts.
    if (outArg) assertContainedPath(dbPath, platformDir, "spec provenance: --out");

    // INIT-13 pre-flight: interactive prompt for skipped siblings —
    // mirrors commands/relations.ts.
    await maybePromptForOnboarding({
      platformDir,
      args: {
        noPrompt: args.noPrompt as boolean | undefined,
      },
    });

    await withReadStorage({ platformDir, dbPath, fresh: !!args.fresh }, async (storage) => {
      // PMAT-03 branch: a non-empty issueId filters the matrix via the bound
      // `$issue` param of provenanceByIssue() (Plan 01); an empty issueId reads
      // the full matrix (Plan 02 path). issueId is NEVER string-interpolated
      // into SQL, never a join/route/coverage key — only a bound filter value.
      const rows = issueId ? storage.provenanceByIssue(issueId) : storage.provenanceMatrix();
      // Empty result in text mode → actionable stderr message, exit 0
      // (read-only command; empty data is not an error). JSON mode stays
      // machine-clean: "[]" on stdout, no message. The message is
      // issue-scoped for a reverse lookup, platform-scoped otherwise.
      if (!args.json && rows.length === 0) {
        console.error(
          issueId
            ? formatNoProvenanceForIssue(issueId, platformDir)
            : formatNoProvenance(platformDir),
        );
        return;
      }
      // Phase 16 (PWEB-02): an explicit if-guard on the opt-in flag. The else
      // branch is the UNCHANGED Phase 13 render — without --resolve-issues the
      // output stays byte-identical (Pitfall 2; provenance-json-snapshot stays
      // green). With the flag, resolve + cache (sidecar only) then render through
      // the SAME shared decorator the webapp uses (Plan 02), so they cannot drift.
      const mode = args.json ? "json" : "text";
      const output = args.resolveIssues
        ? renderProvenanceDecorated(rows, await resolveAndCache(rows, platformDir), mode)
        : renderProvenance(rows, mode);
      console.log(output);
    });
    // Read-only command: exit 0 unconditionally on success.
  },
});
