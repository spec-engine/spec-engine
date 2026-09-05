// packages/engine/src/commands/provenance.ts
//
// `spec provenance [issueId] [platformDir] [--out <path>] [--json]
// [--resolve-issues] [--fresh]`: the per-requirement provenance matrix, or
// the rows one opaque issue id is linked to. The issue id is a display-only
// filter value, never a key. Read-only; `--resolve-issues` overlays tracker
// data through the same decorator the webapp renders with.

import { statSync } from "node:fs";
import { resolve } from "node:path";
import { defineCommand } from "citty";
import { OUT_HELP, resolveDbPath } from "../constants";
import { maybePromptForOnboarding } from "../onboarding/prompt";
import { provenance } from "../operations/reads";
import { renderProvenance, renderProvenanceDecorated } from "../provenance/format";
import { resolveAndCache } from "../provenance/resolve";
import { platformDirArg } from "./_args";
import { assertContainedPath, withReadStorage } from "./_shared";

/** An indexed platform with no issue links is a legitimate empty matrix, not an error. */
function formatNoProvenance(platformDir: string): string {
  return [
    `No provenance links indexed under ${platformDir}.`,
    `Add an "**Issues:** created:ENG-NNNN" line to a requirement in spec-engine/<KEY>/SPEC.md, then re-run \`spec index\`.`,
  ].join("\n");
}

/** A reverse lookup with no matching links is a legitimate empty result; the id is rendered verbatim. */
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
    // Declared before platformDir: citty binds positionals in declaration order.
    issueId: {
      type: "positional",
      required: false,
      description: "Opaque issue id to reverse-lookup, e.g., ENG-1432",
    },
    platformDir: platformDirArg,
    out: {
      type: "string",
      description: OUT_HELP,
    },
    json: {
      type: "boolean",
      description:
        "Emit provenance matrix rows as a JSON array (deterministically sorted, no chrome)",
    },
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
    let issueId = ((args.issueId as string | undefined) ?? "").trim();
    let platformArg = args.platformDir as string | undefined;

    // A lone positional that is an existing directory is the platform dir, not an issue id.
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
    const dbPath = resolveDbPath(platformDir, outArg);
    if (outArg) assertContainedPath(dbPath, platformDir, "spec provenance: --out");

    await maybePromptForOnboarding({
      platformDir,
      args: {
        noPrompt: args.noPrompt as boolean | undefined,
      },
    });

    await withReadStorage({ platformDir, dbPath, fresh: !!args.fresh }, async (storage) => {
      const { rows } = provenance(storage, issueId || undefined);
      if (!args.json && rows.length === 0) {
        console.error(
          issueId
            ? formatNoProvenanceForIssue(issueId, platformDir)
            : formatNoProvenance(platformDir),
        );
        return;
      }
      const mode = args.json ? "json" : "text";
      const output = args.resolveIssues
        ? renderProvenanceDecorated(rows, await resolveAndCache(rows, platformDir), mode)
        : renderProvenance(rows, mode);
      console.log(output);
    });
  },
});
