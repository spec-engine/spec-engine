// packages/engine/src/commands/amend.ts
//
// L3 (lifecycle pass) — `spec amend <KEY-NNN>`: revise an entry's fields
// IN PLACE. The doctrinal counterpart to supersede (README "Amend vs
// supersede"): amend while a requirement has never been true in production
// (same id, no version bump — the truth was refined, not replaced);
// supersede once it has shipped.
//
// REQ-015 (amend is gated to UNSHIPPED entries): "shipped" is measured by
// whether code binds the requirement, not by status alone. The gate is two
// tiers: Superseded/Retired entries are history and refuse (status); an Active
// entry with ≥1 bound @spec tag is shipped truth and refuses (bound-tag) —
// once code implements/verifies a requirement, supersede is the SOLE mutation
// path, so an in-place edit can never rewrite a promise out from under the
// tags that verify it. A Draft entry, or an Active entry with ZERO bound tags,
// is still unshipped and amends freely (pre-ship typo fixes stay off the
// supersede trail). "Bound" = a code-derived tag (implements/verifies); a
// documents-kind mention is not code binding (RED-15 / orphan semantics).
//
//   - Field flags (--text / --why / --lives) name what changes; untouched
//     fields stay byte-identical. At least one is required. (--binds has no
//     JSON home per STOR-01 — it feeds the @-ref warner but is not persisted.)
//   - Envelope `updated` bumps to the local date; `specVersion` is NEVER
//     bumped here (that is supersede's move).
//   - `--json` → { id, file, fields_changed } (sorted field keys).
//   - Exit codes 0 / 2 only. The bound-tag gate (REQ-015) cold-reindexes the
//     platform to count code bindings for the target id — index access via the
//     shared reindexAndListTags seam (openStorage, never bun:sqlite: D-08),
//     the same cold-reindex path `spec supersede` uses. It runs ONLY for an
//     Active entry (Draft short-circuits before any scan).
//
// VAL-01: the amend mutates the requirement OBJECT in the domain's
// SPEC.json and writes ONCE through `validateAndWrite` — no Markdown text
// edit, no bespoke `Bun.write` of the domain file. The seam re-validates the
// WHOLE object (T-17-01) and rejects an invalid edit at author time with the
// SAME INVALID_DOMAIN_FILE diagnostic the index emits (VAL-02).
//
// D-08: no bun:sqlite import.
//
// The `run` handler stays a thin orchestrator: it owns the id-regex guard
// and the platform guard (whose ORDER relative to the field gates is
// load-bearing — id first, platform second, field gates third), then wires
// the extracted validation / lookup / status-gate / mutation helpers below.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { validateAndWrite } from "@spec-engine/shared";
import { defineCommand } from "citty";
import { localToday } from "../authoring/edit";
import { EXIT } from "../constants";
import { assertSpecPlatform } from "../indexer/discover";
import { ID_RE } from "../parser/grammar";
import { handleNotAPlatform, reindexAndListTags } from "./_shared";
import { warnUnresolvableRefs } from "./req";

/** A requirement object inside the JSON envelope (loose — the seam re-validates). */
interface DomainRequirement {
  id: string;
  status?: string;
  statement?: string;
  why?: string | null;
  livesIn?: string[];
  [k: string]: unknown;
}
interface DomainEnvelope {
  requirements?: DomainRequirement[];
  updated?: string;
  [k: string]: unknown;
}

/** Which persistable fields the invocation touched (STOR-01: `--binds` is not one). */
interface AmendFields {
  hasText: boolean;
  hasWhy: boolean;
  hasLives: boolean;
  hasBinds: boolean;
  // Wave B (06-02): the glossary-term fields. amend is domain-generic, so
  // `--term`/`--aliases` revise a TERM entry's headword/synonyms in place
  // (same id, no specVersion bump) exactly as `--text`/`--why`/`--lives` do
  // for a requirement.
  hasTerm: boolean;
  hasAliases: boolean;
}
/** The located entry plus the envelope + paths the single write seam needs. */
interface LocatedEntry {
  req: DomainRequirement;
  domain: DomainEnvelope;
  relFile: string;
  specPath: string;
}

export const amendCommand = defineCommand({
  meta: {
    name: "amend",
    description:
      "Revise an unshipped requirement's fields in place (same id, no specVersion bump). Supersede shipped truth instead.",
  },
  args: {
    id: {
      type: "positional",
      required: true,
      description: "The requirement id to amend (KEY-NNN; must be Active or Draft)",
    },
    platformDir: {
      type: "positional",
      required: false,
      description: "Platform directory containing spec-engine/ (default: cwd)",
    },
    text: { type: "string", description: "New Requirement (statement) field value" },
    why: { type: "string", description: "New Why it matters field value" },
    binds: {
      type: "string",
      description: "Binds value (validated for @-refs; not persisted in JSON — STOR-01)",
    },
    lives: { type: "string", description: "New Lives in (livesIn) field value" },
    term: { type: "string", description: "New TERM headword (term field; TERM ids)" },
    aliases: {
      type: "string",
      description: "New TERM comma-separated aliases (aliases[]; TERM ids)",
    },
    json: {
      type: "boolean",
      description: "Emit { id, file, fields_changed } as JSON instead of the text summary",
    },
  },
  async run({ args }) {
    const id = args.id as string;
    if (!ID_RE.test(id)) {
      console.error(`spec amend: id must be a requirement id (KEY-NNN); got ${id}`);
      process.exit(EXIT.USAGE);
      return;
    }
    const platformDir = resolve((args.platformDir as string | undefined) ?? process.cwd());

    // Platform guard runs BEFORE the field gates (byte-identical ordering):
    // a non-platform dir refuses with the platform message even when no field
    // was passed.
    try {
      assertSpecPlatform(platformDir);
    } catch (e) {
      handleNotAPlatform(e);
    }

    const fields = validateAmendFields(args);
    const located = locateAmendEntry(platformDir, id);
    const { req, domain, relFile, specPath } = await located;
    // Two-tier gate (REQ-015): status first (cheap, no scan), then — for an
    // Active entry only — the bound-tag gate (a cold reindex). A Draft never
    // triggers the scan.
    const statusLc = assertAmendableStatus(id, req);
    if (statusLc === "active") {
      await assertUnshipped(platformDir, id);
    }
    const { fieldsChanged, refValues } = applyAmendMutations(req, args, fields);

    warnUnresolvableRefs(platformDir, refValues);

    domain.updated = localToday();

    const res = await validateAndWrite(specPath, domain, relFile);
    if (!res.ok) {
      for (const diag of res.diagnostics) {
        console.error(`spec amend: ${diag.detail}`);
      }
      process.exit(EXIT.USAGE);
      return;
    }

    const sortedFields = [...fieldsChanged].sort();
    if (args.json) {
      console.log(JSON.stringify({ id, file: relFile, fields_changed: sortedFields }));
    } else {
      console.log(`amended ${id} in ${relFile} (${sortedFields.join(", ")})`);
    }
  },
});

/**
 * Resolve which persistable fields the invocation touched and enforce the two
 * argument gates (exit 2 on failure). At least one PERSISTABLE field is
 * required: `--binds` alone is NOT an amend — it has no JSON home (STOR-01)
 * and only participates in @-ref validation, so it never counts toward
 * "something changed". `--text`, when present, must be non-empty.
 */
function validateAmendFields(args: Record<string, unknown>): AmendFields {
  const hasText = typeof args.text === "string";
  const hasWhy = typeof args.why === "string";
  const hasLives = typeof args.lives === "string";
  const hasBinds = typeof args.binds === "string";
  const hasTerm = typeof args.term === "string";
  const hasAliases = typeof args.aliases === "string";

  if (!hasText && !hasWhy && !hasLives && !hasTerm && !hasAliases) {
    console.error(
      "spec amend: nothing to amend — pass at least one of --text / --why / --lives / --term / --aliases",
    );
    process.exit(EXIT.USAGE);
  }
  if (hasText && (args.text as string).trim() === "") {
    console.error("spec amend: --text must be a non-empty Requirement");
    process.exit(EXIT.USAGE);
  }
  if (hasTerm && (args.term as string).trim() === "") {
    console.error("spec amend: --term must be a non-empty headword");
    process.exit(EXIT.USAGE);
  }
  return { hasText, hasWhy, hasLives, hasBinds, hasTerm, hasAliases };
}

/**
 * Derive the spec path from the id's key slice (never from arbitrary input),
 * read + JSON.parse the envelope, and `.find` the entry. Exits 2 on
 * domain-not-found or entry-not-found. Returns the located entry plus the
 * envelope and paths the single VAL-01 write seam needs.
 */
async function locateAmendEntry(platformDir: string, id: string): Promise<LocatedEntry> {
  const key = id.slice(0, id.indexOf("-"));
  const relFile = `spec-engine/${key}/SPEC.json`;
  const specPath = join(platformDir, "spec-engine", key, "SPEC.json");
  if (!existsSync(specPath)) {
    console.error(`spec amend: no domain ${key} (expected ${relFile} under ${platformDir})`);
    process.exit(EXIT.USAGE);
  }

  const domain = JSON.parse(await Bun.file(specPath).text()) as DomainEnvelope;
  const requirements = Array.isArray(domain.requirements) ? domain.requirements : [];
  const req = requirements.find((r) => r?.id === id);
  if (req === undefined) {
    console.error(`spec amend: no entry ${id} in ${relFile}`);
    process.exit(EXIT.USAGE);
  }
  return { req, domain, relFile, specPath };
}

/**
 * Tier 1 of the amend gate (status): only Active/Draft amend. A
 * Superseded/Retired entry is history — supersede its successor instead
 * (exit 2). Status is a free lowercase string in the JSON envelope; compare
 * case-insensitively and display Capitalized. Returns the lowercased status so
 * the caller can decide whether Tier 2 (the bound-tag gate) applies — it does
 * for Active, but a Draft is unshipped by definition and skips it.
 */
function assertAmendableStatus(id: string, req: DomainRequirement): string {
  const rawStatus = typeof req.status === "string" ? req.status : "";
  const statusLc = rawStatus.toLowerCase();
  if (statusLc !== "active" && statusLc !== "draft") {
    const display = rawStatus ? rawStatus.charAt(0).toUpperCase() + rawStatus.slice(1) : rawStatus;
    console.error(
      `spec amend: ${id} is ${display} — only Active/Draft entries amend (a superseded entry is history; supersede its successor instead)`,
    );
    process.exit(EXIT.USAGE);
  }
  return statusLc;
}

/**
 * Tier 2 of the amend gate (REQ-015, bound tags): an Active requirement that
 * any code implements/verifies is SHIPPED — refuse the in-place edit and
 * direct the author to supersede (exit 2). Cold-reindexes the platform (the
 * shared reindexAndListTags seam) and counts code-derived tags only; a
 * documents-kind mention does not make a requirement shipped (RED-15). Draft
 * entries never reach here — the caller skips Tier 2 for them.
 */
async function assertUnshipped(platformDir: string, id: string): Promise<void> {
  // @spec REQ-015
  const tags = await reindexAndListTags(platformDir, id);
  const bound = tags.filter((t) => t.kind === "implements" || t.kind === "verifies");
  if (bound.length > 0) {
    const site = bound[0];
    console.error(
      `spec amend: ${id} is shipped — ${bound.length} code tag(s) bind it (e.g. ${site.file}:${site.line}). ` +
        "A bound requirement is immutable; supersede it with a successor instead of amending in place.",
    );
    process.exit(EXIT.USAGE);
  }
}

/**
 * Apply the whitelisted field mutations, tracking what changed (for the
 * fields_changed report) and the values to run through the @-ref warner.
 * Keeps the trim + why-empty→null + lives-empty→[] semantics EXACTLY, and
 * `--binds` participates in refValues ONLY (not persisted — STOR-01).
 */
function applyAmendMutations(
  req: DomainRequirement,
  args: Record<string, unknown>,
  fields: AmendFields,
): { fieldsChanged: string[]; refValues: string[] } {
  const fieldsChanged: string[] = [];
  const refValues: string[] = [];
  if (fields.hasText) {
    const v = (args.text as string).trim();
    req.statement = v;
    fieldsChanged.push("requirement");
    refValues.push(v);
  }
  if (fields.hasWhy) {
    const v = (args.why as string).trim();
    req.why = v === "" ? null : v;
    fieldsChanged.push("why");
    refValues.push(v);
  }
  if (fields.hasLives) {
    const v = (args.lives as string).trim();
    req.livesIn = v === "" ? [] : [v];
    fieldsChanged.push("lives");
    refValues.push(v);
  }
  if (fields.hasBinds) {
    // Not persisted (STOR-01) — validated for @-refs only.
    refValues.push((args.binds as string).trim());
  }
  // Wave B (06-02): glossary-term fields. `--term` sets the headword; `--aliases`
  // splits on comma into aliases[]. Whitelisted mutations only — the whole
  // object still re-validates through validateDomainFile (T-06-07).
  // @spec REQ-014
  if (fields.hasTerm) {
    const v = (args.term as string).trim();
    req.term = v;
    fieldsChanged.push("term");
    refValues.push(v);
  }
  if (fields.hasAliases) {
    const raw = (args.aliases as string).trim();
    req.aliases =
      raw === ""
        ? []
        : raw
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s !== "");
    fieldsChanged.push("aliases");
  }
  return { fieldsChanged, refValues };
}
