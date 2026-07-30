// packages/engine/src/commands/deprecate.ts
//
// `spec deprecate <KEY-NNN> --reason "..."` — the end-of-life command (D1,
// 2026-07-30). A requirement is never deleted; when its behavior is being
// removed with no successor, this command marks it deprecated and records
// WHY, on the entry itself. The reason lives in SPEC.json — not in a code
// comment — because the code carrying a comment is exactly what is about to
// be deleted.
//
// After this write:
//   - `spec gate` FAILS the id (reason DEPRECATED),
//   - a code tag still on the id is a DEPRECATED_REFERENCED error in
//     `spec check` — the emitted worklist below is that list,
//   - the id leaves live search, and
//   - `spec guard` allows the bound code to be deleted in the same change
//     (the entry survives as the record; only Active promises demand code).
//
// Guards run before any write. Only an Active or Draft entry deprecates:
// a superseded entry is already history, an already-deprecated entry is a
// no-op error. VAL-01: the single object edit writes ONCE through
// validateAndWrite. Exit codes 0 / 2. D-08: no bun:sqlite import.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { validateAndWrite } from "@spec-engine/shared";
import { defineCommand } from "citty";
import { localToday } from "../authoring/edit";
import { EXIT } from "../constants";
import { assertSpecPlatform } from "../indexer/discover";
import { ID_RE } from "../parser/grammar";
import { type ReqTagRow, renderReqTags } from "../resolve/format";
import { handleNotAPlatform, reindexAndListTags } from "./_shared";

/** A requirement object inside the JSON envelope (loose — the seam re-validates). */
interface DomainRequirement {
  id: string;
  status?: string;
  deprecatedReason?: string;
  [k: string]: unknown;
}

interface DomainEnvelope {
  requirements?: DomainRequirement[];
  updated?: string;
  [k: string]: unknown;
}

/** Resolve + guard the deprecation target. Every failure prints and exits 2;
 *  a normal return means an Active/Draft entry ready to flip. */
async function resolveDeprecateTarget(
  platformDir: string,
  id: string,
): Promise<{ domain: DomainEnvelope; req: DomainRequirement; specPath: string; relFile: string }> {
  const key = id.slice(0, id.indexOf("-"));
  const relFile = `spec-engine/${key}/SPEC.json`;
  const specPath = join(platformDir, "spec-engine", key, "SPEC.json");
  if (!existsSync(specPath)) {
    console.error(`spec deprecate: no domain ${key} (expected ${relFile} under ${platformDir})`);
    process.exit(EXIT.USAGE);
  }
  const domain = JSON.parse(await Bun.file(specPath).text()) as DomainEnvelope;
  const requirements = Array.isArray(domain.requirements) ? domain.requirements : [];
  const req = requirements.find((r) => r?.id === id);
  if (req === undefined) {
    console.error(`spec deprecate: no entry ${id} in ${relFile}`);
    process.exit(EXIT.USAGE);
  }
  const statusLc = (typeof req.status === "string" ? req.status : "").toLowerCase();
  if (statusLc === "deprecated" || statusLc === "retired") {
    console.error(`spec deprecate: ${id} is already deprecated`);
    process.exit(EXIT.USAGE);
  }
  if (statusLc !== "active" && statusLc !== "draft") {
    console.error(
      `spec deprecate: ${id} is ${req.status} — only Active/Draft entries deprecate (a superseded entry is already history)`,
    );
    process.exit(EXIT.USAGE);
  }
  return { domain, req, specPath, relFile };
}

export const deprecateCommand = defineCommand({
  meta: {
    name: "deprecate",
    description:
      "Mark a requirement end-of-life with a recorded reason (a requirement is never deleted)",
  },
  args: {
    id: {
      type: "positional",
      required: true,
      description: "Requirement id to deprecate (KEY-NNN)",
    },
    platformDir: {
      type: "positional",
      required: false,
      description: "Platform directory (default: cwd)",
    },
    reason: {
      type: "string",
      description: "Why this requirement is end-of-life (required — the durable record)",
    },
    json: {
      type: "boolean",
      description: "Print { id, file, reason, sites } instead of text",
    },
  },
  async run({ args }) {
    const id = args.id as string;
    const platformDir = resolve((args.platformDir as string | undefined) ?? process.cwd());
    const reason = ((args.reason as string | undefined) ?? "").trim();

    if (!ID_RE.test(id)) {
      console.error(`spec deprecate: id must be a requirement id (KEY-NNN); got ${id}`);
      process.exit(EXIT.USAGE);
    }
    if (reason === "") {
      console.error(
        "spec deprecate: --reason is required — the reason is the durable record of why this requirement ended",
      );
      process.exit(EXIT.USAGE);
    }
    try {
      assertSpecPlatform(platformDir);
    } catch (e) {
      handleNotAPlatform(e);
    }

    const { domain, req, specPath, relFile } = await resolveDeprecateTarget(platformDir, id);

    // The single object edit (VAL-01): status + reason, envelope date bump.
    // @spec REQ-021
    req.status = "deprecated";
    req.deprecatedReason = reason;
    domain.updated = localToday();
    const res = await validateAndWrite(specPath, domain, relFile);
    if (!res.ok) {
      for (const diag of res.diagnostics) console.error(`spec deprecate: ${diag.detail}`);
      process.exit(EXIT.USAGE);
    }

    // Fresh reindex + the cleanup worklist: every tag still on the id is now
    // a DEPRECATED_REFERENCED error until the code is removed or retagged.
    const tags = await reindexAndListTags(platformDir, id);
    const sites: ReqTagRow[] = tags.map(({ req_id, repo, file, line, kind, level }) => ({
      req_id,
      repo,
      file,
      line,
      kind: kind as string,
      level: (level ?? null) as string | null,
    }));

    if (args.json) {
      console.log(JSON.stringify({ id, file: relFile, reason, sites }));
      return;
    }
    console.log(`deprecated ${id} in ${relFile} — reason recorded`);
    if (sites.length > 0) {
      console.error(
        `${sites.length} code tag(s) still bind ${id} — remove or retag them (spec check reports each as DEPRECATED_REFERENCED):`,
      );
      console.error(renderReqTags(sites, "text"));
    }
  },
});
