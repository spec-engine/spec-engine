// packages/engine/src/commands/move.ts
//
// `spec move <KEY-NNN> <NEW-DOMAIN>` (4.7) — the cross-domain counterpart of
// `spec supersede`. `supersede` mints a successor in the SAME domain; `move`
// mints it in a DIFFERENT one, carrying the source entry's fields forward, and
// marks the source `Superseded by <NEW-ID>`. It exists so a taxonomy
// reorganization (this repo's own AUTHC→DOMAIN+REQ, POC dissolution, GATE→PROOF)
// is a real, auditable supersession with a retag worklist — not a hand-edited
// rename that loses history.
//
// Mechanics (all guards run BEFORE any write):
//   1. Flip the source entry to status:"superseded", supersededBy:NEW.
//   2. Mint NEW as the next unused id IN THE TARGET DOMAIN and append it Active,
//      copying the source's statement/why/livesIn — flags override so a
//      non-standalone requirement can be rewritten AS it moves (4.8).
//   3. Bump BOTH envelopes' specVersion (+1) and updated — the source lost a
//      requirement, the target gained one. --no-bump opts out of both.
//   4. Pre-validate both envelopes, then write both through the ONE
//      validateAndWrite seam (VAL-01), fresh-reindex, and emit the RETAG
//      WORKLIST: every tag site still on the old id (the sites `spec check`
//      flags as SUPERSEDED_REFERENCED until retagged to NEW).
//
// Cross-domain supersededBy is just an id string — the schema already permits
// it, and the index resolves supersededBy globally, so check/propagation treat
// the moved id exactly like an in-domain supersession.
//
// Exit codes: 0 success, 2 usage/guard errors. D-08: no bun:sqlite import.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Diagnostic, validateAndWrite, validateDomainFile } from "@spec-engine/shared";
import { defineCommand } from "citty";
import { nextRequirementId, normalizeDomainKey } from "../authoring/domains";
import { localToday } from "../authoring/edit";
import { defaultIndexPath, EXIT } from "../constants";
import { assertSpecPlatform } from "../indexer/discover";
import { runIndex } from "../indexer/pipeline";
import { deriveDomainVersion } from "../parser/domainJson";
import { ID_RE } from "../parser/grammar";
import { type ReqTagRow, renderReqTags } from "../resolve/format";
import { openStorage } from "../storage/sqlite";
import { coldResetDb, handleNotAPlatform } from "./_shared";
import { warnUnresolvableRefs } from "./req";

/** A requirement object inside the JSON envelope (loose — the seam re-validates). */
interface DomainRequirement {
  id: string;
  status?: string;
  statement?: string;
  why?: string | null;
  supersedes?: string | null;
  supersededBy?: string | null;
  relates?: string[];
  livesIn?: string[];
  issues?: unknown[];
  changedAtVersion?: number;
  [k: string]: unknown;
}
interface DomainEnvelope {
  specVersion?: number;
  requirements?: DomainRequirement[];
  updated?: string;
  [k: string]: unknown;
}

/** One side of a move: the parsed envelope plus the paths to write it back. */
interface DomainSide {
  domain: DomainEnvelope;
  requirements: DomainRequirement[];
  specPath: string;
  relFile: string;
  key: string;
}

/** Read + JSON-parse a domain envelope, exiting 2 on a missing/unparseable
 *  file (all guards fail before any write). */
async function loadDomainSide(platformDir: string, key: string): Promise<DomainSide | null> {
  const relFile = `spec-engine/${key}/SPEC.json`;
  const specPath = join(platformDir, "spec-engine", key, "SPEC.json");
  if (!existsSync(specPath)) return null;
  const domain = JSON.parse(await Bun.file(specPath).text()) as DomainEnvelope;
  const requirements = Array.isArray(domain.requirements) ? domain.requirements : [];
  return { domain, requirements, specPath, relFile, key };
}

/** Resolved move target: both domain sides plus the located Active source entry. */
interface MoveTarget {
  source: DomainSide;
  target: DomainSide;
  req: DomainRequirement;
}

/**
 * Resolve + guard the move. Owns the ID_RE guard, the platform pre-flight, both
 * domain-file existence checks, the same-domain guard, the entry lookup, and the
 * Active-only status guard. A normal return means every guard passed.
 */
async function resolveMoveTarget(
  id: string,
  rawTargetKey: string,
  platformDir: string,
): Promise<MoveTarget> {
  if (!ID_RE.test(id)) {
    console.error(`spec move: id must be a requirement id (KEY-NNN); got ${id}`);
    process.exit(EXIT.USAGE);
  }
  const targetKey = normalizeDomainKey(rawTargetKey);
  if (targetKey === "") {
    console.error(
      `spec move: <NEW-DOMAIN> must be a domain key; got ${JSON.stringify(rawTargetKey)}`,
    );
    process.exit(EXIT.USAGE);
  }

  try {
    assertSpecPlatform(platformDir);
  } catch (e) {
    handleNotAPlatform(e);
  }

  const sourceKey = id.slice(0, id.indexOf("-"));
  if (sourceKey === targetKey) {
    console.error(
      `spec move: ${id} is already in ${targetKey} — use spec supersede for an in-domain revision`,
    );
    process.exit(EXIT.USAGE);
  }

  const source = await loadDomainSide(platformDir, sourceKey);
  if (source === null) {
    console.error(
      `spec move: no domain ${sourceKey} (expected spec-engine/${sourceKey}/SPEC.json)`,
    );
    process.exit(EXIT.USAGE);
  }
  const target = await loadDomainSide(platformDir, targetKey);
  if (target === null) {
    console.error(
      `spec move: no target domain ${targetKey} — run \`spec domain new ${targetKey}\` first`,
    );
    process.exit(EXIT.USAGE);
  }

  const req = source.requirements.find((r) => r?.id === id);
  if (req === undefined) {
    console.error(`spec move: no entry ${id} in ${source.relFile}`);
    process.exit(EXIT.USAGE);
  }
  const statusLc = (typeof req.status === "string" ? req.status : "").toLowerCase();
  if (statusLc !== "active") {
    const display = req.status ? String(req.status) : "unknown";
    console.error(
      `spec move: ${id} is ${display} — only Active requirements move (superseded/retired entries stay as history)`,
    );
    process.exit(EXIT.USAGE);
  }

  return { source, target, req };
}

/** Successor fields: copy the source's, override with any provided flags (a move
 *  preserves the requirement, but flags let a non-standalone one be rewritten as
 *  it moves — 4.8). */
function resolveSuccessorFields(
  args: Record<string, unknown>,
  req: DomainRequirement,
): { statement: string; why: string; lives: string } {
  const srcStatement = typeof req.statement === "string" ? req.statement : "";
  const srcWhy = typeof req.why === "string" ? req.why : "";
  const srcLives =
    Array.isArray(req.livesIn) && req.livesIn.length > 0 ? String(req.livesIn[0]) : "";
  return {
    statement: ((args.text as string | undefined) ?? srcStatement).trim(),
    why: ((args.why as string | undefined) ?? srcWhy).trim(),
    lives: ((args.lives as string | undefined) ?? srcLives).trim(),
  };
}

/** Resolve the version to report for one side of a move. A requirement
 *  (non-TERM) domain's version is the DAG-derived projection over its OWN
 *  requirements after the edit — no authored counter is written (SCHM-008 /
 *  REQ-016); adding an Active successor adds no edge, so a target domain's
 *  derived version is unchanged while the source's advances by the one edge it
 *  gained. The reserved TERM domain keeps its authored specVersion bump (the
 *  drift pin; a revise adds no edge to derive), honoring --no-bump. Always
 *  advances `updated`. */
function resolveMoveVersion(domain: DomainEnvelope, key: string, noBump: boolean): number | null {
  domain.updated = localToday();
  if (key !== "TERM") {
    // @spec REQ-016
    return deriveDomainVersion(domain.requirements ?? []);
  }
  if (noBump) return null;
  const current = typeof domain.specVersion === "number" ? domain.specVersion : 1;
  const next = current + 1;
  domain.specVersion = next;
  return next;
}

/** Apply the in-memory edits to both sides (all guards have passed). Mutates
 *  both envelopes and returns the two new specVersions. */
function applyMoveEdit(
  target: MoveTarget,
  newId: string,
  fields: { statement: string; why: string; lives: string },
  noBump: boolean,
): { sourceVersion: number | null; targetVersion: number | null } {
  // 1. Flip the source entry forward (cross-domain supersededBy is a plain id).
  const sourceCurrent =
    typeof target.source.domain.specVersion === "number" ? target.source.domain.specVersion : 1;
  target.req.status = "superseded";
  target.req.supersededBy = newId;
  // 2. Append the successor Active in the target domain.
  target.target.requirements.push({
    id: newId,
    status: "active",
    statement: fields.statement,
    why: fields.why === "" ? null : fields.why,
    supersedes: null,
    supersededBy: null,
    relates: [],
    livesIn: fields.lives === "" ? [] : [fields.lives],
    issues: [],
  });
  target.target.domain.requirements = target.target.requirements;
  // 3. Version each side (derive for requirement domains; TERM keeps its bump).
  const sourceVersion = resolveMoveVersion(target.source.domain, target.source.key, noBump);
  const targetVersion = resolveMoveVersion(target.target.domain, target.target.key, noBump);
  // Stamp the source's died-at version. Non-TERM: the DAG-derived source version
  // (the supersede edge just added is now counted). TERM under --no-bump: the
  // unchanged current. See supersede.ts for the semantics.
  target.req.supersededAtVersion = sourceVersion ?? sourceCurrent;
  return { sourceVersion, targetVersion };
}

/** Fresh reindex (canonical truth just changed on two files) + collect the retag
 *  worklist for the old id. */
async function reindexAndCollectRetag(platformDir: string, id: string): Promise<ReqTagRow[]> {
  const dbPath = defaultIndexPath(platformDir);
  coldResetDb(dbPath);
  const storage = openStorage(dbPath);
  try {
    await runIndex({ platformDir, storage });
    return storage.listTags({ req_id: id }).map(({ req_id, repo, file, line, kind, level }) => ({
      req_id,
      repo,
      file,
      line,
      kind: kind as string,
      level: (level ?? null) as string | null,
    }));
  } finally {
    storage.close();
  }
}

export const moveCommand = defineCommand({
  meta: {
    name: "move",
    description:
      "Move a requirement to another domain: mint the successor in <NEW-DOMAIN> carrying the source's fields, mark the source superseded, bump both specVersions, and emit the retag worklist.",
  },
  args: {
    id: {
      type: "positional",
      required: true,
      description: "The requirement id to move (KEY-NNN; must be Active)",
    },
    newDomain: {
      type: "positional",
      required: true,
      description: "The target domain key (must already exist; spec domain new <KEY> first)",
    },
    platformDir: {
      type: "positional",
      required: false,
      description: "Platform directory containing spec-engine/ (default: cwd)",
    },
    text: {
      type: "string",
      description: "Rewrite the successor's Requirement (default: copied from the source)",
    },
    why: {
      type: "string",
      description: "Rewrite the successor's Why (default: copied from the source)",
    },
    lives: {
      type: "string",
      description: "Rewrite the successor's Lives in (default: copied from the source)",
    },
    noBump: {
      type: "boolean",
      description: "Do not bump either envelope's specVersion",
    },
    json: {
      type: "boolean",
      description:
        "Emit { old_id, new_id, from_file, to_file, source_spec_version, target_spec_version, retag } as JSON",
    },
  },
  async run({ args }) {
    const id = args.id as string;
    const rawTargetKey = args.newDomain as string;
    const platformDir = resolve((args.platformDir as string | undefined) ?? process.cwd());

    const target = await resolveMoveTarget(id, rawTargetKey, platformDir);
    const fields = resolveSuccessorFields(args as Record<string, unknown>, target.req);
    if (fields.statement === "") {
      console.error(`spec move: ${id} has an empty Requirement — cannot move a blank statement`);
      process.exit(EXIT.USAGE);
    }
    warnUnresolvableRefs(platformDir, [fields.statement, fields.why, fields.lives]);

    const newId = await nextRequirementId(platformDir, target.target.key);
    const { sourceVersion, targetVersion } = applyMoveEdit(
      target,
      newId,
      fields,
      Boolean(args.noBump),
    );

    // VAL-01: pre-validate BOTH envelopes before writing EITHER, so a reject on
    // the second file can never leave the first half-applied. Then write both
    // through the one validateAndWrite seam.
    const diagnostics: Diagnostic[] = [];
    const srcCheck = validateDomainFile(target.source.domain, target.source.relFile);
    if (!srcCheck.ok) diagnostics.push(...srcCheck.diagnostics);
    const tgtCheck = validateDomainFile(target.target.domain, target.target.relFile);
    if (!tgtCheck.ok) diagnostics.push(...tgtCheck.diagnostics);
    if (diagnostics.length > 0) {
      for (const diag of diagnostics) console.error(`spec move: ${diag.detail}`);
      process.exit(EXIT.USAGE);
      return;
    }

    await validateAndWrite(target.target.specPath, target.target.domain, target.target.relFile);
    await validateAndWrite(target.source.specPath, target.source.domain, target.source.relFile);

    const retag = await reindexAndCollectRetag(platformDir, id);

    if (args.json) {
      console.log(
        JSON.stringify({
          old_id: id,
          new_id: newId,
          from_file: target.source.relFile,
          to_file: target.target.relFile,
          source_spec_version: sourceVersion,
          target_spec_version: targetVersion,
          retag,
        }),
      );
    } else {
      console.log(`moved ${id} → ${newId} (${target.source.key} → ${target.target.key})`);
      if (sourceVersion !== null || targetVersion !== null) {
        console.log(
          `specVersion: ${target.source.key}→${sourceVersion}, ${target.target.key}→${targetVersion}`,
        );
      }
      if (retag.length > 0) {
        console.log(`retag ${retag.length} site(s) from ${id} to ${newId}:`);
        console.log(renderReqTags(retag, "text"));
      }
    }
    if (retag.length > 0) {
      console.error(
        `note: spec check will report SUPERSEDED_REFERENCED at each remaining ${id} tag until the sites are retagged to ${newId}`,
      );
    }
  },
});
