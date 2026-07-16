// packages/engine/src/commands/supersede.ts
//
// L2 (lifecycle pass) — `spec supersede <KEY-NNN>`: the core lifecycle
// operation, mechanized. The README's doctrine is "supersede after ship":
// the old id is retained and pointed forward, a new id carries the revised
// truth, and members pinned behind start showing DRIFT. Until now that
// was a multi-file hand-edit; this command performs the mechanical part:
//
//   1. Flip the predecessor to `status:"superseded"`, `supersededBy:NEW`.
//   2. Mint NEW (next unused id) and append it Active — Requirement text
//      from --text (or TTY prompt); Why/Lives from flags, defaulting to a
//      COPY of the old entry's values (bindings usually survive a revision;
//      flags override when they don't).
//   3. Report the domain version and stamp the predecessor's died-at. On a
//      requirement (non-TERM) domain that version is DAG-derived (the new
//      supersede edge is counted); NO authored `specVersion` is written
//      (SCHM-008) and `--no-bump` is a no-op. On the reserved TERM domain the
//      authored `specVersion` bumps (+1) — its drift pin — honoring `--no-bump`.
//      Always advances `updated`.
//   4. Fresh reindex (rm + rebuild — correctness over cache; the write just
//      changed canonical truth) and emit the RETAG WORKLIST: every tag site
//      still referencing OLD. These are exactly the sites `spec check` will
//      flag as SUPERSEDED_REFERENCED until retagged.
//
// VAL-01: steps 1-3 are a SINGLE object edit written ONCE through
// `validateAndWrite` (JSON) — no Markdown text edit, no bespoke `Bun.write`
// of the domain file. The seam re-validates the WHOLE object (T-17-01) and
// rejects an invalid edit at author time with the same INVALID_DOMAIN_FILE
// diagnostic the index emits (VAL-02). Guards never leave a half-written
// file — all validation happens before the write, and the write is atomic.
//
// Exit codes: 0 success, 2 usage/guard errors (exit 1 stays reserved for
// `spec check --ci` / `gate`).
//
// D-08: no bun:sqlite import — index access goes through openStorage.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { validateAndWrite } from "@spec-engine/shared";
import { defineCommand } from "citty";
import { nextRequirementId } from "../authoring/domains";
import { localToday } from "../authoring/edit";
import { EXIT } from "../constants";
import { assertSpecPlatform } from "../indexer/discover";
import { deriveDomainVersion } from "../parser/domainJson";
import { ID_RE } from "../parser/grammar";
import { type ReqTagRow, renderReqTags } from "../resolve/format";
import { handleNotAPlatform, reindexAndListTags } from "./_shared";
import { askLine, warnUnresolvableRefs } from "./req";

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

/** Resolved supersession target: the parsed domain object plus the located
 *  predecessor entry and the paths needed to write it back. */
interface SupersedeTarget {
  domain: DomainEnvelope;
  requirements: DomainRequirement[];
  req: DomainRequirement;
  specPath: string;
  relFile: string;
  key: string;
}

/**
 * Stage (a): resolve + guard the supersession target. Owns the ID_RE guard,
 * the platform pre-flight, the domain-file existence check, the entry lookup,
 * and the active-only status guards. Every failure emits the exact stderr and
 * exits 2 (`process.exit` → `never`), so a normal return means a valid, Active
 * target — all guards have passed before any write is attempted.
 */
async function resolveSupersedeTarget(id: string, platformDir: string): Promise<SupersedeTarget> {
  if (!ID_RE.test(id)) {
    console.error(`spec supersede: id must be a requirement id (KEY-NNN); got ${id}`);
    process.exit(EXIT.USAGE);
  }

  try {
    assertSpecPlatform(platformDir);
  } catch (e) {
    handleNotAPlatform(e);
  }

  // Domain key is the id's prefix; the entry must live in that domain's
  // SPEC.json (the KEY-NNN ⊂ spec-engine/KEY/ convention).
  const key = id.slice(0, id.indexOf("-"));
  const relFile = `spec-engine/${key}/SPEC.json`;
  const specPath = join(platformDir, "spec-engine", key, "SPEC.json");
  if (!existsSync(specPath)) {
    console.error(`spec supersede: no domain ${key} (expected ${relFile} under ${platformDir})`);
    process.exit(EXIT.USAGE);
  }

  const domain = JSON.parse(await Bun.file(specPath).text()) as DomainEnvelope;
  const requirements = Array.isArray(domain.requirements) ? domain.requirements : [];
  const req = requirements.find((r) => r?.id === id);
  if (req === undefined) {
    console.error(`spec supersede: no entry ${id} in ${relFile}`);
    process.exit(EXIT.USAGE);
  }

  // Only an Active requirement can be superseded. A Draft has never been
  // truth (amend it); a Superseded/Retired entry is already history. Status
  // is a free lowercase string in the JSON envelope.
  const statusLc = (typeof req.status === "string" ? req.status : "").toLowerCase();
  if (statusLc === "superseded") {
    console.error(
      `spec supersede: ${id} is already superseded by ${req.supersededBy} — supersede that successor instead`,
    );
    process.exit(EXIT.USAGE);
  }
  if (statusLc !== "active") {
    const display = req.status
      ? String(req.status).charAt(0).toUpperCase() + String(req.status).slice(1)
      : String(req.status);
    console.error(
      `spec supersede: ${id} is ${display} — only Active requirements supersede (amend a Draft in place)`,
    );
    process.exit(EXIT.USAGE);
  }

  return { domain, requirements, req, specPath, relFile, key };
}

/**
 * Stage (b1): the successor's Requirement text — flag, or TTY prompt. Non-TTY
 * without --text is an error (the successor's truth cannot be defaulted); an
 * empty --text is rejected; an empty interactive prompt aborts cleanly
 * (exit 0, nothing written).
 */
async function resolveSuccessorText(args: Record<string, unknown>, id: string): Promise<string> {
  let requirement = ((args.text as string | undefined) ?? "").trim();
  if (requirement === "") {
    if (typeof args.text === "string") {
      console.error("spec supersede: --text must be a non-empty Requirement");
      process.exit(EXIT.USAGE);
    }
    if (!process.stdin.isTTY) {
      console.error(
        "spec supersede: --text <requirement> is required when stdin is not a TTY (the successor needs its truth)",
      );
      process.exit(EXIT.USAGE);
    }
    console.error(`Superseding ${id} — new entry will be allocated next`);
    requirement = (await askLine("Successor Requirement: ")).trim();
    if (requirement === "") {
      console.error("spec supersede: aborted — empty Requirement, nothing written");
      process.exit(EXIT.OK);
    }
  }
  return requirement;
}

/**
 * Stage (b2): the successor's Why/Lives + binds. Flags win; otherwise carry
 * the old entry's values forward (bindings usually survive a revision).
 * `binds` has no JSON home (STOR-01) — it feeds the @-ref warner but is not
 * persisted.
 */
function resolveSuccessorFields(
  args: Record<string, unknown>,
  req: DomainRequirement,
): { why: string; lives: string; binds: string } {
  const predWhy = typeof req.why === "string" ? req.why : "";
  const predLives =
    Array.isArray(req.livesIn) && req.livesIn.length > 0 ? String(req.livesIn[0]) : "";
  const why = ((args.why as string | undefined) ?? predWhy).trim();
  const lives = ((args.lives as string | undefined) ?? predLives).trim();
  const binds = ((args.binds as string | undefined) ?? "").trim();
  return { why, lives, binds };
}

/**
 * Wave B (06-02) — the TERM successor-field branch. supersede is domain-generic
 * (it derives the domain from the id prefix), so it operates on TERM ids for
 * free EXCEPT that the fresh successor object below hardcodes the requirement
 * shape and would DROP a term's `term`/`aliases`. When the target domain is
 * TERM, resolve those two fields: `--term`/`--aliases` win; otherwise copy the
 * predecessor's values forward (a revised definition usually keeps its
 * headword + synonyms). The whole object still re-validates through
 * validateDomainFile (T-06-07), so this branch injects no unchecked key.
 * @spec REQ-014
 */
function resolveSuccessorTermFields(
  args: Record<string, unknown>,
  req: DomainRequirement,
): { term: string | undefined; aliases: string[] } {
  const predTerm = typeof req.term === "string" ? req.term : undefined;
  const term = ((args.term as string | undefined) ?? predTerm)?.trim() || predTerm;
  const rawAliases = args.aliases as string | undefined;
  const aliases =
    typeof rawAliases === "string"
      ? rawAliases
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s !== "")
      : Array.isArray(req.aliases)
        ? req.aliases.map((a) => String(a))
        : [];
  return { term, aliases };
}

/**
 * Stage (c): the VAL-01 single object edit (all guards have passed). Mutates
 * `domain`/`requirements` in place and returns the new specVersion (null when
 * --no-bump); the caller writes the whole object ONCE through validateAndWrite.
 */
function applySupersedeEdit(
  target: SupersedeTarget,
  newId: string,
  requirement: string,
  why: string,
  lives: string,
  noBump: boolean,
  termFields: { term: string | undefined; aliases: string[] } | null,
): number | null {
  const { domain, requirements, req } = target;
  // 1. Flip the predecessor forward.
  req.status = "superseded";
  req.supersededBy = newId;
  // 2. Append the successor Active (mirror appendEntry's object shape).
  const successor: DomainRequirement = {
    id: newId,
    status: "active",
    statement: requirement,
    why: why === "" ? null : why,
    supersedes: null,
    supersededBy: null,
    relates: [],
    livesIn: lives === "" ? [] : [lives],
    issues: [],
    changedAtVersion: 1,
  };
  // Wave B (06-02): a TERM successor carries its headword + synonyms forward
  // (copied unless overridden) — otherwise the fresh requirement shape above
  // would silently drop them (T-06-07).
  if (termFields !== null) {
    if (termFields.term !== undefined) successor.term = termFields.term;
    successor.aliases = termFields.aliases;
  }
  requirements.push(successor);
  domain.requirements = requirements;
  // 3. Version. A requirement (non-TERM) domain reports the DAG-derived domain
  //    version — the supersede edge set in step 1 is now counted, and NO authored
  //    counter is written (SCHM-008 / REQ-016). The died-at stamp is that same
  //    derived number, carried verbatim by the index (never recomputed, so a
  //    lineage shows the true "superseded at vN"). The reserved TERM domain keeps
  //    its authored specVersion bump: a `spec term revise` adds no supersede edge,
  //    so that counter is the only pin a citation's drift can lag, and --no-bump
  //    still opts out of it.
  // @spec REQ-016
  let reportedVersion: number | null;
  if (domain.key === "TERM") {
    const currentVersion = typeof domain.specVersion === "number" ? domain.specVersion : 1;
    reportedVersion = noBump ? null : currentVersion + 1;
    if (reportedVersion !== null) domain.specVersion = reportedVersion;
    req.supersededAtVersion = reportedVersion ?? currentVersion;
  } else {
    reportedVersion = deriveDomainVersion(requirements);
    req.supersededAtVersion = reportedVersion;
  }
  domain.updated = localToday();
  return reportedVersion;
}

/**
 * Stage (d): fresh reindex (canonical truth just changed) + collect the retag
 * worklist — every tag site still referencing the old id, exactly the sites
 * `spec check` will flag as SUPERSEDED_REFERENCED until retagged. The
 * cold-reindex + single `listTags` core lives in {@link reindexAndListTags}
 * (shared with `spec amend`'s bound-tag gate); supersede owns only the
 * ReqTagRow projection its worklist renderer needs.
 */
async function reindexAndCollectRetag(platformDir: string, id: string): Promise<ReqTagRow[]> {
  const tags = await reindexAndListTags(platformDir, id);
  return tags.map(({ req_id, repo, file, line, kind, level }) => ({
    req_id,
    repo,
    file,
    line,
    kind: kind as string,
    level: (level ?? null) as string | null,
  }));
}

export const supersedeCommand = defineCommand({
  meta: {
    name: "supersede",
    description:
      "Supersede a shipped requirement: flip it to superseded, mint the successor, bump specVersion, and emit the retag worklist.",
  },
  args: {
    id: {
      type: "positional",
      required: true,
      description: "The requirement id to supersede (KEY-NNN; must be Active)",
    },
    platformDir: {
      type: "positional",
      required: false,
      description: "Platform directory containing spec-engine/ (default: cwd)",
    },
    text: {
      type: "string",
      description:
        "The successor's Requirement field. Required when stdin is not a TTY; prompted otherwise.",
    },
    why: {
      type: "string",
      description: "Successor's Why it matters (default: copied from the old entry)",
    },
    binds: {
      type: "string",
      description: "Binds value (validated for @-refs; not persisted in JSON — STOR-01)",
    },
    lives: {
      type: "string",
      description: "Successor's Lives in (default: copied from the old entry)",
    },
    term: {
      type: "string",
      description: "TERM successor's headword (default: copied from the old entry; TERM ids only)",
    },
    aliases: {
      type: "string",
      description:
        "TERM successor's comma-separated aliases (default: copied from the old entry; TERM ids only)",
    },
    noBump: {
      type: "boolean",
      description: "Do not bump the envelope specVersion",
    },
    json: {
      type: "boolean",
      description:
        "Emit { old_id, new_id, file, spec_version, retag } as JSON instead of the text summary",
    },
  },
  async run({ args }) {
    const id = args.id as string;
    const platformDir = resolve((args.platformDir as string | undefined) ?? process.cwd());

    const target = await resolveSupersedeTarget(id, platformDir);
    const requirement = await resolveSuccessorText(args as Record<string, unknown>, id);
    const { why, lives, binds } = resolveSuccessorFields(
      args as Record<string, unknown>,
      target.req,
    );
    warnUnresolvableRefs(platformDir, [requirement, why, binds, lives]);

    const newId = await nextRequirementId(platformDir, target.key);
    // Wave B (06-02): only a TERM target carries the term/aliases branch — the
    // requirement domains keep the exact prior successor shape.
    const termFields =
      target.key === "TERM"
        ? resolveSuccessorTermFields(args as Record<string, unknown>, target.req)
        : null;
    const newVersion = applySupersedeEdit(
      target,
      newId,
      requirement,
      why,
      lives,
      Boolean(args.noBump),
      termFields,
    );

    // VAL-01: the single object edit above is written ONCE through
    // validateAndWrite (JSON) — no Markdown text edit, no bespoke Bun.write of
    // the domain file. The seam re-validates the WHOLE object (T-17-01) and
    // rejects an invalid edit at author time with the same INVALID_DOMAIN_FILE
    // diagnostic the index emits (VAL-02). Every guard ran before this atomic
    // write, so a rejected edit leaves no half-written file.
    const res = await validateAndWrite(target.specPath, target.domain, target.relFile);
    if (!res.ok) {
      for (const diag of res.diagnostics) {
        console.error(`spec supersede: ${diag.detail}`);
      }
      process.exit(EXIT.USAGE);
      return;
    }

    const retag = await reindexAndCollectRetag(platformDir, id);

    if (args.json) {
      console.log(
        JSON.stringify({
          old_id: id,
          new_id: newId,
          file: target.relFile,
          spec_version: newVersion,
          retag,
        }),
      );
    } else {
      console.log(`superseded ${id} → ${newId} in ${target.relFile}`);
      if (newVersion !== null) console.log(`specVersion bumped to ${newVersion}`);
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
