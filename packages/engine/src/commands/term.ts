// packages/engine/src/commands/term.ts
//
// Dogfood (spec self-consumes this repo — see spec-engine/):
// @spec REQ-014
//
// Wave B (06-02) — `spec term`: the glossary-term authoring surface. A term IS
// a requirement row (FORK 1 = reuse, not a parallel schema): the definition
// lives in the `statement` field, the headword in `term`, its synonyms in
// `aliases`. The command is a thin req.ts-style wrapper (FORK 4) over the
// EXISTING lifecycle substrate — `nextRequirementId(platformDir, "TERM")` for
// id allocation and the ONE `validateAndWrite` seam for the write (VAL-01: no
// bespoke Bun.write of a domain file). supersede/amend operate on TERM ids for
// free (they are domain-generic) modulo the successor-field branch in
// supersede.ts / amend.ts that carries term/aliases forward.
//
//   spec term <name> --def <definition> [--aliases a,b] [--section s]  — author
//   spec term list                                                     — enumerate
//   spec term revise <TERM-NNN> --def <definition>                     — A2 in-place revise + version bump
//   spec term confirm <KEY-NNN> <TERM-NNN>                             — re-pin a citation (clears TERM_DRIFT / re-points a superseded cite)
//
// Non-TTY id contract (mirror req.ts:167-172): with NO --def/--text the command
// is a pure id query — the bare next unused TERM id on stdout (or
// { domain, next_id } under --json), zero prompts, zero writes. `--def` is the
// authoring gate (like req.ts's `--text`), so a term is only written when its
// definition is supplied.
//
// ROUTING: `list` / `revise` / `confirm` are dispatched MANUALLY from the root
// `run` on the first positional (NOT citty subCommands). citty 0.2.2 refuses any
// first positional that is not a registered subcommand name ("Unknown command"),
// which would break the bare `spec term <name>` authoring form. The tradeoff is
// that a term literally named `list` / `revise` / `confirm` cannot be authored
// via the bare form — an acceptable reserved-word collision. The standalone
// termListCommand / termReviseCommand / termConfirmCommand objects stay exported
// so each surface keeps a self-contained, directly-testable `run`.
//
// `spec term list` reads the FILESYSTEM (spec-engine/TERM/SPEC.json), mirroring
// `domain list` — D-08: NO bun:sqlite import in the command, no derived-index
// access, no `.spec-engine/` artifact left behind. Exit codes 0/2 only.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { validateAndWrite } from "@spec-engine/shared";
import { defineCommand } from "citty";
import { nextRequirementId } from "../authoring/domains";
import { localToday } from "../authoring/edit";
import { defaultIndexPath, EXIT } from "../constants";
import { assertSpecPlatform } from "../indexer/discover";
import { runIndex } from "../indexer/pipeline";
import { ID_RE } from "../parser/grammar";
import { openStorage } from "../storage/sqlite";
import { coldResetDb, handleNotAPlatform } from "./_shared";
import { warnUnresolvableRefs } from "./req";

const TERM_KEY = "TERM";

/** A requirement/term object inside the JSON envelope (loose — the seam re-validates). */
interface TermRequirement {
  id: string;
  status?: string;
  statement?: string;
  term?: string;
  aliases?: string[];
  supersededBy?: string | null;
  cites?: Array<{ term: string; pinned: number }>;
  changedAtVersion?: number;
  [k: string]: unknown;
}
interface TermEnvelope {
  specVersion?: number;
  requirements?: TermRequirement[];
  updated?: string;
  [k: string]: unknown;
}

/** Split a `--aliases "a, b, c"` flag into a trimmed, empty-filtered array. */
function parseAliases(raw: string | undefined): string[] {
  if (typeof raw !== "string" || raw.trim() === "") return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/** Resolve the optional platformDir positional + run the platform guard. */
function resolvePlatform(platformDirRaw: string | undefined): string {
  const platformDir = resolve(platformDirRaw ?? process.cwd());
  try {
    assertSpecPlatform(platformDir);
  } catch (e) {
    handleNotAPlatform(e);
  }
  return platformDir;
}

/** Read + JSON.parse the TERM envelope (or exit 2 if the domain has no SPEC.json). */
async function readTermEnvelope(platformDir: string, cmd: string): Promise<TermEnvelope> {
  const specPath = join(platformDir, "spec-engine", TERM_KEY, "SPEC.json");
  if (!existsSync(specPath)) {
    console.error(
      `spec ${cmd}: no TERM domain (expected spec-engine/TERM/SPEC.json under ${platformDir})`,
    );
    process.exit(EXIT.USAGE);
  }
  return JSON.parse(await Bun.file(specPath).text()) as TermEnvelope;
}

/**
 * Append a new TERM entry through the single VAL-01 seam (never a bespoke
 * Bun.write of the domain file). Mirrors req.ts's appendEntry object shape but
 * carries the glossary-term fields (`term`/`aliases`/`cites`) — each present in
 * the orderDomain whitelist, so they survive the write. Returns the
 * platform-relative spec path.
 */
async function appendTermEntry(
  platformDir: string,
  id: string,
  fields: { term: string; def: string; aliases: string[]; section: string | undefined },
): Promise<string> {
  const relFile = `spec-engine/${TERM_KEY}/SPEC.json`;
  const specPath = join(platformDir, "spec-engine", TERM_KEY, "SPEC.json");
  const domain = await readTermEnvelope(platformDir, "term");
  const requirements = Array.isArray(domain.requirements) ? domain.requirements : [];
  const entry: TermRequirement = {
    id,
    status: "active",
    statement: fields.def,
    term: fields.term,
    why: null,
    supersedes: null,
    supersededBy: null,
    relates: [],
    livesIn: [],
    issues: [],
    aliases: fields.aliases,
    cites: [],
    changedAtVersion: 1,
  };
  if (fields.section !== undefined) entry.section = fields.section;
  requirements.push(entry);
  domain.requirements = requirements;
  domain.updated = localToday();

  const res = await validateAndWrite(specPath, domain, relFile);
  if (!res.ok) {
    for (const diag of res.diagnostics) {
      console.error(`spec term: ${diag.detail}`);
    }
    process.exit(EXIT.USAGE);
  }
  return relFile;
}

// ── Core surfaces (shared by the standalone command objects and the root
// dispatcher) ────────────────────────────────────────────────────────────────

/**
 * `spec term <name>` — author a TERM (definition via --def/--text), OR, when no
 * definition is supplied, a pure next-id query (mirror req.ts's D-02 contract):
 * the bare next unused TERM id (or { domain, next_id } under --json), zero
 * writes.
 */
async function authorOrQuery(opts: {
  name: string;
  platformDirRaw: string | undefined;
  def: string | undefined;
  aliasesRaw: string | undefined;
  section: string | undefined;
  json: boolean;
}): Promise<void> {
  const platformDir = resolvePlatform(opts.platformDirRaw);
  const nextId = await nextRequirementId(platformDir, TERM_KEY);

  if (opts.def === undefined) {
    if (opts.json) {
      console.log(JSON.stringify({ domain: TERM_KEY, next_id: nextId }));
    } else {
      console.log(nextId);
    }
    return;
  }

  const definition = opts.def.trim();
  if (definition === "") {
    console.error("spec term: --def must be a non-empty definition");
    process.exit(EXIT.USAGE);
    return;
  }

  warnUnresolvableRefs(platformDir, [opts.name, definition]);
  const relFile = await appendTermEntry(platformDir, nextId, {
    term: opts.name,
    def: definition,
    aliases: parseAliases(opts.aliasesRaw),
    section: opts.section,
  });
  if (opts.json) {
    console.log(JSON.stringify({ id: nextId, file: relFile }));
  } else {
    console.log(`appended ${nextId} to ${relFile}`);
  }
}

/** `spec term list` — enumerate the TERM entries from the filesystem (D-08). */
async function listTerms(platformDirRaw: string | undefined, json: boolean): Promise<void> {
  const platformDir = resolvePlatform(platformDirRaw);
  const specPath = join(platformDir, "spec-engine", TERM_KEY, "SPEC.json");
  const domain: TermEnvelope = existsSync(specPath)
    ? (JSON.parse(await Bun.file(specPath).text()) as TermEnvelope)
    : { requirements: [] };
  const requirements = Array.isArray(domain.requirements) ? domain.requirements : [];
  const rows = requirements
    .map((r) => ({
      id: typeof r.id === "string" ? r.id : "",
      term: typeof r.term === "string" ? r.term : "",
      status: typeof r.status === "string" ? r.status : "",
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  if (json) {
    console.log(JSON.stringify(rows));
    return;
  }
  for (const row of rows) {
    console.log(`${row.id}  ${row.term}  ${row.status}`);
  }
}

/**
 * Guard + resolve the revise target: id-regex, TERM-prefix, platform, non-empty
 * def, and the located entry. Every failure emits stderr + exits 2 (→ `never`),
 * so a normal return is a valid, located TERM entry ready to revise.
 */
async function resolveReviseTarget(
  id: string,
  platformDirRaw: string | undefined,
  defRaw: string | undefined,
): Promise<{
  platformDir: string;
  def: string;
  domain: TermEnvelope;
  req: TermRequirement;
  relFile: string;
  specPath: string;
}> {
  if (!ID_RE.test(id)) {
    console.error(`spec term revise: id must be a requirement id (TERM-NNN); got ${id}`);
    process.exit(EXIT.USAGE);
  }
  // revise operates on the glossary store only — a non-TERM id is a usage error
  // (supersede/amend cover the requirement domains).
  if (id.slice(0, id.indexOf("-")) !== TERM_KEY) {
    console.error(`spec term revise: ${id} is not a TERM id — revise operates on the TERM store`);
    process.exit(EXIT.USAGE);
  }
  const platformDir = resolvePlatform(platformDirRaw);

  const def = (defRaw ?? "").trim();
  if (def === "") {
    console.error("spec term revise: --def <definition> is required (a non-empty revision)");
    process.exit(EXIT.USAGE);
  }

  const relFile = `spec-engine/${TERM_KEY}/SPEC.json`;
  const specPath = join(platformDir, "spec-engine", TERM_KEY, "SPEC.json");
  const domain = await readTermEnvelope(platformDir, "term revise");
  const requirements = Array.isArray(domain.requirements) ? domain.requirements : [];
  const req = requirements.find((r) => r?.id === id);
  if (req === undefined) {
    console.error(`spec term revise: no entry ${id} in ${relFile}`);
    process.exit(EXIT.USAGE);
  }
  // Lifecycle guard (parity with `spec amend`): only Active/Draft entries revise
  // in place. A Superseded term is history — its meaning already moved to a
  // successor id; a Retired term is closed. Re-writing either in place would
  // rewrite shipped truth. Supersede instead.
  const statusLc = (typeof req.status === "string" ? req.status : "").toLowerCase();
  if (statusLc !== "active" && statusLc !== "draft") {
    console.error(
      `spec term revise: ${id} is ${req.status} — only Active/Draft terms revise in place (supersede a shipped term instead)`,
    );
    process.exit(EXIT.USAGE);
  }
  return { platformDir, def, domain, req, relFile, specPath };
}

/**
 * `spec term revise <TERM-NNN> --def` — the A2 op requirements do NOT have:
 * rewrite the definition IN PLACE (same id) and bump the envelope specVersion +
 * the entry's changedAtVersion (the pin every citing requirement drifts against
 * in Wave E). `--no-bump` opts out.
 */
async function reviseTerm(opts: {
  id: string;
  platformDirRaw: string | undefined;
  def: string | undefined;
  noBump: boolean;
  json: boolean;
}): Promise<void> {
  const { platformDir, def, domain, req, relFile, specPath } = await resolveReviseTarget(
    opts.id,
    opts.platformDirRaw,
    opts.def,
  );

  warnUnresolvableRefs(platformDir, [def]);

  req.statement = def;
  let newVersion: number | null = null;
  if (!opts.noBump) {
    const current = typeof domain.specVersion === "number" ? domain.specVersion : 1;
    newVersion = current + 1;
    domain.specVersion = newVersion;
    req.changedAtVersion = newVersion;
  }
  domain.updated = localToday();

  const res = await validateAndWrite(specPath, domain, relFile);
  if (!res.ok) {
    for (const diag of res.diagnostics) {
      console.error(`spec term revise: ${diag.detail}`);
    }
    process.exit(EXIT.USAGE);
    return;
  }

  if (opts.json) {
    console.log(JSON.stringify({ id: opts.id, file: relFile, spec_version: newVersion }));
  } else {
    console.log(`revised ${opts.id} in ${relFile}`);
    if (newVersion !== null) console.log(`specVersion bumped to ${newVersion}`);
  }
}

/**
 * Fresh reindex after a confirm write (mirror supersede.ts's
 * reindexAndCollectRetag idiom): cold-reset the DB then rebuild, so a subsequent
 * warm read reflects the re-pinned/re-pointed citation. D-08: index access goes
 * through openStorage, never a direct bun:sqlite import.
 */
async function reindexFresh(platformDir: string): Promise<void> {
  const dbPath = defaultIndexPath(platformDir);
  coldResetDb(dbPath);
  const storage = openStorage(dbPath);
  try {
    await runIndex({ platformDir, storage });
  } finally {
    storage.close();
  }
}

/**
 * Resolve the confirm TARGET from the TERM store: an Active term confirms to
 * ITSELF; a Superseded term RE-POINTS to its successor id — the drift-clearing
 * re-point. Both pin to the term's CURRENT domain specVersion (the plan's "pin
 * to the term's current specVersion"): a glossary term has no per-entry version
 * — the envelope specVersion IS its version, and the index caps any term's
 * `changed_at_version` at the domain specVersion (a supersession target, e.g.
 * the successor here, reads changed_at_version = specVersion, NOT its authored
 * `changedAtVersion`). So pinning to specVersion always clears the `term_drift`
 * predicate (`term.changed_at_version > pinned`). Every guard failure emits
 * stderr + exits 2 (`never`).
 */
async function resolveConfirmTarget(
  platformDir: string,
  termId: string,
): Promise<{ targetId: string; targetPin: number }> {
  const termDomain = await readTermEnvelope(platformDir, "term confirm");
  const termReqs = Array.isArray(termDomain.requirements) ? termDomain.requirements : [];
  const term = termReqs.find((r) => r?.id === termId);
  if (term === undefined) {
    console.error(`spec term confirm: no term ${termId} in spec-engine/${TERM_KEY}/SPEC.json`);
    process.exit(EXIT.USAGE);
  }
  const targetPin = typeof termDomain.specVersion === "number" ? termDomain.specVersion : 1;
  const statusLc = (typeof term.status === "string" ? term.status : "").toLowerCase();
  if (statusLc !== "superseded") {
    return { targetId: termId, targetPin };
  }
  const successorId = typeof term.supersededBy === "string" ? term.supersededBy : "";
  if (successorId === "") {
    console.error(`spec term confirm: ${termId} is superseded but names no successor`);
    process.exit(EXIT.USAGE);
  }
  return { targetId: successorId, targetPin };
}

/**
 * Load the citing requirement's domain (key from the id prefix) and locate the
 * citation still pointing at the pre-confirm term id. Every guard failure emits
 * stderr + exits 2 (`never`); a normal return is a located, mutable citation.
 */
async function locateCitation(
  platformDir: string,
  reqId: string,
  termId: string,
): Promise<{
  citDomain: TermEnvelope;
  specPath: string;
  relFile: string;
  cite: { term: string; pinned: number };
}> {
  const citKey = reqId.slice(0, reqId.indexOf("-"));
  const relFile = `spec-engine/${citKey}/SPEC.json`;
  const specPath = join(platformDir, "spec-engine", citKey, "SPEC.json");
  if (!existsSync(specPath)) {
    console.error(
      `spec term confirm: no domain ${citKey} (expected ${relFile} under ${platformDir})`,
    );
    process.exit(EXIT.USAGE);
  }
  const citDomain = JSON.parse(await Bun.file(specPath).text()) as TermEnvelope;
  const citReqs = Array.isArray(citDomain.requirements) ? citDomain.requirements : [];
  const citReq = citReqs.find((r) => r?.id === reqId);
  if (citReq === undefined) {
    console.error(`spec term confirm: no entry ${reqId} in ${relFile}`);
    process.exit(EXIT.USAGE);
  }
  const cites = Array.isArray(citReq.cites) ? citReq.cites : [];
  const cite = cites.find((c) => c?.term === termId);
  if (cite === undefined) {
    console.error(`spec term confirm: ${reqId} does not cite ${termId}`);
    process.exit(EXIT.USAGE);
  }
  return { citDomain, specPath, relFile, cite };
}

/**
 * `spec term confirm <REQ-ID> <TERM-ID>` — advance a citation's pin to the cited
 * term's CURRENT version, clearing TERM_DRIFT (the re-confirmation the drift
 * model demands after a `spec term revise` version-bump). When the cited term is
 * SUPERSEDED, RE-POINT the citation to its successor id (clearing
 * SUPERSEDED_TERM_REFERENCED). The whole citing domain is re-written ONCE through
 * validateAndWrite (VAL-01), then reindexed fresh.
 * @spec CHCK-005
 */
async function confirmCitation(opts: {
  reqId: string;
  termId: string;
  platformDirRaw: string | undefined;
  json: boolean;
}): Promise<void> {
  const { reqId, termId } = opts;
  if (!ID_RE.test(reqId)) {
    console.error(`spec term confirm: req id must be a requirement id (KEY-NNN); got ${reqId}`);
    process.exit(EXIT.USAGE);
  }
  if (!ID_RE.test(termId) || termId.slice(0, termId.indexOf("-")) !== TERM_KEY) {
    console.error(
      `spec term confirm: ${termId} is not a TERM id — confirm re-pins a TERM citation`,
    );
    process.exit(EXIT.USAGE);
  }
  const platformDir = resolvePlatform(opts.platformDirRaw);

  const { targetId, targetPin } = await resolveConfirmTarget(platformDir, termId);
  const { citDomain, specPath, relFile, cite } = await locateCitation(platformDir, reqId, termId);

  // The single VAL-01 object edit: advance the pin (and re-point on supersession).
  cite.term = targetId;
  cite.pinned = targetPin;

  const res = await validateAndWrite(specPath, citDomain, relFile);
  if (!res.ok) {
    for (const diag of res.diagnostics) {
      console.error(`spec term confirm: ${diag.detail}`);
    }
    process.exit(EXIT.USAGE);
    return;
  }

  await reindexFresh(platformDir);

  if (opts.json) {
    console.log(
      JSON.stringify({ req_id: reqId, term_id: targetId, pinned: targetPin, file: relFile }),
    );
  } else {
    console.log(`confirmed ${reqId} cites ${targetId} @${targetPin} in ${relFile}`);
  }
}

// ── Command objects ──────────────────────────────────────────────────────────

export const termListCommand = defineCommand({
  meta: {
    name: "list",
    description: "List the glossary TERM entries (id, name, status), sorted by id",
  },
  args: {
    platformDir: {
      type: "positional",
      required: false,
      description: "Platform directory containing spec-engine/ (default: cwd)",
    },
    json: {
      type: "boolean",
      description: "Emit a sorted array of { id, term, status } instead of the per-line text",
    },
  },
  async run({ args }) {
    await listTerms(args.platformDir as string | undefined, Boolean(args.json));
  },
});

export const termReviseCommand = defineCommand({
  meta: {
    name: "revise",
    description:
      "Revise a TERM's definition IN PLACE (same id) and BUMP the envelope specVersion — the drift signal (A2). Requirements have no such op.",
  },
  args: {
    id: {
      type: "positional",
      required: true,
      description: "The TERM id to revise (TERM-NNN)",
    },
    platformDir: {
      type: "positional",
      required: false,
      description: "Platform directory containing spec-engine/ (default: cwd)",
    },
    def: { type: "string", description: "The revised definition (statement)" },
    text: { type: "string", description: "Alias for --def (the revised definition)" },
    noBump: { type: "boolean", description: "Do not bump the envelope specVersion" },
    json: {
      type: "boolean",
      description: "Emit { id, file, spec_version } as JSON instead of the text summary",
    },
  },
  async run({ args }) {
    await reviseTerm({
      id: args.id as string,
      platformDirRaw: args.platformDir as string | undefined,
      def: (args.def as string | undefined) ?? (args.text as string | undefined),
      noBump: Boolean(args.noBump),
      json: Boolean(args.json),
    });
  },
});

export const termConfirmCommand = defineCommand({
  meta: {
    name: "confirm",
    description:
      "Re-pin a requirement's TERM citation to the term's current version (clears TERM_DRIFT); re-points to the successor when the term is superseded (clears SUPERSEDED_TERM_REFERENCED).",
  },
  args: {
    reqId: {
      type: "positional",
      required: true,
      description: "The citing requirement id (KEY-NNN)",
    },
    termId: {
      type: "positional",
      required: true,
      description: "The cited TERM id to re-confirm (TERM-NNN)",
    },
    platformDir: {
      type: "positional",
      required: false,
      description: "Platform directory containing spec-engine/ (default: cwd)",
    },
    json: {
      type: "boolean",
      description: "Emit { req_id, term_id, pinned, file } as JSON instead of the text summary",
    },
  },
  async run({ args }) {
    await confirmCitation({
      reqId: args.reqId as string,
      termId: args.termId as string,
      platformDirRaw: args.platformDir as string | undefined,
      json: Boolean(args.json),
    });
  },
});

export const termCommand = defineCommand({
  meta: {
    name: "term",
    description:
      "Author a glossary TERM (spec term <name> --def <definition>), list terms (spec term list), or revise a definition in place (spec term revise TERM-NNN)",
  },
  // NOTE: no citty `subCommands` — see the ROUTING note in the file header.
  // `list` / `revise` are dispatched manually below so bare `spec term <name>`
  // authoring survives citty 0.2.2's Unknown-command guard.
  args: {
    name: {
      type: "positional",
      required: true,
      description:
        "The term's headword, or the literal `list` / `revise` verb. Without --def (author form), prints the next unused TERM id.",
    },
    platformDir: {
      type: "positional",
      required: false,
      description:
        "Platform directory (author/list), or — after `revise` — the TERM-NNN id to revise, or — after `confirm` — the citing KEY-NNN id",
    },
    extra: {
      type: "positional",
      required: false,
      description:
        "After `revise <TERM-NNN>`: the platform directory (default: cwd). After `confirm <KEY-NNN>`: the TERM-NNN id.",
    },
    extra2: {
      type: "positional",
      required: false,
      description: "After `confirm <KEY-NNN> <TERM-NNN>`: the platform directory (default: cwd)",
    },
    def: { type: "string", description: "The term's definition (stored in the statement field)" },
    text: { type: "string", description: "Alias for --def (the definition)" },
    aliases: { type: "string", description: "Comma-separated synonyms → aliases[]" },
    section: { type: "string", description: "GLOSSARY.md layout bucket (Wave F)" },
    noBump: { type: "boolean", description: "revise: do not bump the envelope specVersion" },
    json: {
      type: "boolean",
      description:
        "Author: { id, file } (or { domain, next_id } as an id query). list: the entries array. revise: { id, file, spec_version }.",
    },
  },
  async run({ args }) {
    const verb = args.name as string;
    const def = (args.def as string | undefined) ?? (args.text as string | undefined);
    const json = Boolean(args.json);

    // Manual sub-dispatch on the first positional (see the ROUTING note).
    if (verb === "list") {
      await listTerms(args.platformDir as string | undefined, json);
      return;
    }
    if (verb === "revise") {
      // `spec term revise <TERM-NNN> [platformDir]`: the id lands in the second
      // positional, the platform dir in the third.
      await reviseTerm({
        id: (args.platformDir as string | undefined) ?? "",
        platformDirRaw: args.extra as string | undefined,
        def,
        noBump: Boolean(args.noBump),
        json,
      });
      return;
    }
    if (verb === "confirm") {
      // `spec term confirm <KEY-NNN> <TERM-NNN> [platformDir]`: the citing req id
      // lands in the second positional, the TERM id in the third, the platform
      // dir in the fourth.
      await confirmCitation({
        reqId: (args.platformDir as string | undefined) ?? "",
        termId: (args.extra as string | undefined) ?? "",
        platformDirRaw: args.extra2 as string | undefined,
        json,
      });
      return;
    }

    await authorOrQuery({
      name: verb,
      platformDirRaw: args.platformDir as string | undefined,
      def,
      aliasesRaw: args.aliases as string | undefined,
      section: args.section as string | undefined,
      json,
    });
  },
});
