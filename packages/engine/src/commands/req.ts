// packages/engine/src/commands/req.ts
//
// Dogfood (spec self-consumes this repo — see spec-engine/):
// @spec REQ-001
// @spec REQ-002
// @spec REQ-003
// @spec REQ-004
// @spec REQ-006
// @spec REQ-007
// @spec REQ-008
// @spec REQ-009
// @spec REQ-010
// @spec REQ-013
// @spec REQ-017
//
// `spec req <domain-prefix> [platformDir]` resolves a case-insensitive
// domain prefix.
// On a TTY it authors a new requirement interactively (260605-tqz / D-01);
// non-TTY (pipes / agents / CI) it prints the next unused requirement id —
// the composable id query is preserved byte-for-byte (D-02).
//
// Behaviors (AUTHC IDs):
//   - AUTHC-010 — prefix matched case-insensitively against the filesystem
//     domain listing (`bil` → BILLING); the input goes through the same
//     normalizeDomainKey as `domain new`, so matching is uppercase-on-uppercase.
//   - AUTHC-011 — exact match wins over prefix matches; otherwise a UNIQUE
//     prefix resolves.
//   - AUTHC-012 — ambiguous prefix → stderr candidate list + exit 2.
//   - AUTHC-013 — no match → stderr available-domains list + exit 2. This is
//     a deliberate change vs the retired `spec id`: a nonexistent domain no
//     longer prints `<KEY>-001` — `spec domain new` is the way to create one.
//   - AUTHC-014 — next id is max(seq)+1 over SPEC.json, padded to 3 digits.
//   - AUTHC-015 — non-platform dir → formatNotASpecPlatform + exit 2.
//   - AUTHC-019 — TTY gate (D-01): stdin isTTY → per-field prompt flow
//     (Requirement / Why it matters / Binds / Lives in) via node:readline,
//     prompts rendered to STDERR (T-10-03 — stdout stays machine-parseable);
//     the allocated id + `— Active` status are displayed but not editable.
//   - AUTHC-020 — non-TTY fallback (D-02): prints the next unused id, exit 0;
//     no prompts, no writes. This branch runs FIRST so pipes/agents/CI never
//     construct a readline interface.
//   - AUTHC-021 — empty Requirement aborts: exit 0 (LOCKED per D-01 — git
//     editor-abort tradition), stderr notice, zero bytes written.
//   - AUTHC-022 — append shape: the new requirement is added to the domain's
//     SPEC.json `requirements[]`; `updated` is bumped to the LOCAL-timezone
//     date (domain.ts construction — NEVER toISOString, AUTHC-004 / WR-05);
//     the appended entry advances the next allocated id.
//   - AUTHC-024 — @-ref authoring-time validation (D-03): unresolvable refs
//     warn to stderr and never block the save.
//
// The prefix is NEVER used to build a filesystem path directly — it only
// selects from listDomainKeys' already-enumerated, containment-safe names
// (threat T-kma-03). Exit codes are 0/2 only (AUTHC-016). D-08: NO
// bun:sqlite import — no derived-index access, no `.spec-engine/`
// artifact left behind. Pitfall 4 (10-01 precedent): rl.close() lives in
// a `finally` block, NEVER inside the Promise executor.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { validateAndWrite } from "@spec-engine/shared";
import { defineCommand } from "citty";
import {
  domainScope,
  listDomainKeys,
  nextRequirementId,
  normalizeDomainKey,
} from "../authoring/domains";
import { localToday } from "../authoring/edit";
import { extractRefsFromText, resolveFileRef } from "../authoring/filerefs";
import { EXIT } from "../constants";
import { assertSpecPlatform } from "../indexer/discover";
import { handleNotAPlatform } from "./_shared";

export const reqCommand = defineCommand({
  meta: {
    name: "req",
    description:
      "Author a new requirement interactively (TTY) or print the next unused id (non-TTY)",
  },
  args: {
    domainPrefix: {
      type: "positional",
      required: true,
      description: "Domain key or unique case-insensitive prefix (e.g. `bil` for BILLING)",
    },
    platformDir: {
      type: "positional",
      required: false,
      description:
        "Platform directory (default: cwd). Domains live under <platformDir>/spec-engine/",
    },
    json: {
      type: "boolean",
      description:
        "Without --text: print the next unused id as JSON ({domain, next_id}), zero prompts, zero writes. With --text: print the authored entry as JSON ({id, file}).",
    },
    text: {
      type: "string",
      description:
        "L1 non-interactive authoring: the Requirement field. When set, the entry appends with zero prompts (flags win over interactivity).",
    },
    why: {
      type: "string",
      description: "Why it matters field (only with --text)",
    },
    binds: {
      type: "string",
      description: "Binds field (only with --text)",
    },
    lives: {
      type: "string",
      description: "Lives in field (only with --text)",
    },
  },
  async run({ args }) {
    const input = args.domainPrefix as string;
    const platformDir = resolve((args.platformDir as string | undefined) ?? process.cwd());

    // AUTHC-015: platform guard FIRST — same command-boundary pattern as
    // map/index/check (friendly message + exit 2, rethrow anything else).
    try {
      assertSpecPlatform(platformDir);
    } catch (e) {
      handleNotAPlatform(e);
    }

    // AUTHC-010/011/012/013: resolve the case-insensitive prefix to a single
    // enumerated domain key (or exit 2). Extracted so `run` stays the
    // guard → resolve → dispatch orchestrator.
    const key = resolveDomainKey(input, platformDir);
    // AUTHC-014: max(seq)+1 over SPEC.json, padded.
    const nextId = await nextRequirementId(platformDir, key);

    // L1: field-flag authoring — the agent write-path. `--text` is the
    // gate; the secondary field flags are meaningless without it (a silent
    // partial entry would be worse than an error).
    const textFlag = args.text as string | undefined;
    const hasFieldFlags =
      typeof args.why === "string" ||
      typeof args.binds === "string" ||
      typeof args.lives === "string";
    if (textFlag === undefined && hasFieldFlags) {
      console.error(
        "spec req: --why/--binds/--lives require --text (the Requirement field is mandatory)",
      );
      process.exit(EXIT.USAGE);
      return;
    }
    if (textFlag !== undefined) {
      await authorFromFieldFlags(platformDir, key, nextId, textFlag, {
        why: args.why as string | undefined,
        binds: args.binds as string | undefined,
        lives: args.lives as string | undefined,
        json: Boolean(args.json),
      });
      return;
    }

    // T4 (audit hygiene pass): --json is machine mode — an agent that asked
    // for JSON never wants readline, so this branch runs BEFORE the TTY
    // gate. Same zero-prompt / zero-write contract as the non-TTY branch.
    if (args.json) {
      console.log(JSON.stringify({ domain: key, next_id: nextId }));
      return;
    }

    // AUTHC-020 (D-02): non-TTY FIRST — pipes/agents/CI get the bare next
    // id with zero prompts and zero writes; no readline interface is ever
    // constructed on this branch.
    if (!process.stdin.isTTY) {
      console.log(nextId);
      return;
    }

    // AUTHC-019 (D-01): interactive per-field flow. The allocated id +
    // Active status are display-only (rendered to stderr — T-10-03).
    console.error(`Authoring ${nextId} — Active`);
    // @spec CHRT-005: at authoring time, echo the resolved domain's charter to
    // STDERR (the chrome channel) so the author writes to spec. This runs ONLY
    // on the interactive + --text authoring paths, NEVER on the piped bare-id or
    // --json id-query branches above — so stdout stays byte-identical.
    await printResolvedCharter(platformDir, key);

    const requirement = (await askLine("Requirement: ")).trim();
    // AUTHC-021 abort gate — BEFORE any file I/O. Exit 0 is LOCKED per
    // D-01 (git editor-abort tradition: an abandoned edit is not an error).
    if (requirement === "") {
      console.error("spec req: aborted — empty Requirement, nothing written");
      process.exit(EXIT.OK);
      return;
    }
    const why = (await askLine("Why it matters: ")).trim();
    const binds = (await askLine("Binds: ")).trim();
    const lives = (await askLine("Lives in: ")).trim();

    // AUTHC-024 (D-03): authoring-time @-ref validation — warn per
    // unresolvable ref, NEVER block the save. The index pipeline emits the
    // matching BROKEN_FILE_REF diagnostic on the next `spec index`.
    warnUnresolvableRefs(platformDir, [requirement, why, binds, lives]);

    const relFile = await appendEntry(platformDir, key, nextId, {
      requirement,
      why,
      binds,
      lives,
    });
    console.log(`appended ${nextId} to ${relFile}`);
  },
});

/**
 * AUTHC-010/011/012/013: resolve a case-insensitive domain prefix to exactly
 * one enumerated key, or exit 2. The prefix is NEVER used to build a
 * filesystem path directly — it only selects from listDomainKeys'
 * already-enumerated, containment-safe names (threat T-kma-03).
 */
function resolveDomainKey(input: string, platformDir: string): string {
  // AUTHC-010: uppercase the input via the shared normalization so the
  // match against the already-uppercase keys is case-insensitive.
  const prefix = normalizeDomainKey(input);
  const keys = listDomainKeys(platformDir);

  // AUTHC-011: exact match wins over any longer-prefix ambiguity.
  if (keys.includes(prefix)) {
    return prefix;
  }
  const matches = keys.filter((k) => k.startsWith(prefix));
  if (matches.length === 1) {
    return matches[0] as string;
  }
  if (matches.length > 1) {
    // AUTHC-012: ambiguous.
    console.error(`spec req: "${input}" is ambiguous — candidates: ${matches.join(", ")}`);
    process.exit(EXIT.USAGE);
  }
  // AUTHC-013: no match — list what exists instead of inventing
  // `<KEY>-001` for a domain that does not.
  const available = keys.length > 0 ? keys.join(", ") : "(none)";
  console.error(`spec req: no domain matches "${input}" — available: ${available}`);
  process.exit(EXIT.USAGE);
}

/**
 * L1 `--text` field-flag authoring path — the agent write-path. Guards the
 * non-empty Requirement, runs the AUTHC-024 @-ref warning, appends through
 * the single VAL-01 seam, and prints JSON ({id, file}) or the text notice.
 * Behavior is byte-identical to the inline branch it replaced.
 */
async function authorFromFieldFlags(
  platformDir: string,
  key: string,
  nextId: string,
  textFlag: string,
  opts: {
    why: string | undefined;
    binds: string | undefined;
    lives: string | undefined;
    json: boolean;
  },
): Promise<void> {
  const requirement = textFlag.trim();
  if (requirement === "") {
    console.error("spec req: --text must be a non-empty Requirement");
    process.exit(EXIT.USAGE);
  }
  // @spec CHRT-005: charter echo on the --text authoring path (stderr chrome).
  await printResolvedCharter(platformDir, key);
  const why = (opts.why ?? "").trim();
  const binds = (opts.binds ?? "").trim();
  const lives = (opts.lives ?? "").trim();
  warnUnresolvableRefs(platformDir, [requirement, why, binds, lives]);
  const relFile = await appendEntry(platformDir, key, nextId, {
    requirement,
    why,
    binds,
    lives,
  });
  if (opts.json) {
    console.log(JSON.stringify({ id: nextId, file: relFile }));
  } else {
    console.log(`appended ${nextId} to ${relFile}`);
  }
}

/**
 * CHRT-005: print the resolved domain's charter (`scope`) to STDERR — the chrome
 * channel — at authoring time. Reuses the shared `domainScope` filesystem helper
 * (no re-implemented read, no bun:sqlite import — the D-08 fence stays green).
 * A null/absent charter degrades to a single "no charter set" notice; charter
 * text NEVER reaches stdout, so the piped bare-id and --json id-query contracts
 * (which never call this) stay byte-identical.
 */
async function printResolvedCharter(platformDir: string, key: string): Promise<void> {
  const scope = await domainScope(platformDir, key);
  if (scope !== null && scope.trim() !== "") {
    console.error(`Charter — ${key}: ${scope}`);
  } else {
    console.error(`spec req: no charter set for ${key}`);
  }
}

/** AUTHC-024 (D-03): warn per unresolvable `@<path>` ref; never block.
 *  Exported for reuse by `spec supersede` / `spec amend`. */
export function warnUnresolvableRefs(platformDir: string, fieldValues: string[]): void {
  for (const value of fieldValues) {
    for (const ref of extractRefsFromText(value)) {
      if (!resolveFileRef(platformDir, ref)) {
        console.error(`spec req: warning — @${ref} does not resolve under ${platformDir}`);
      }
    }
  }
}

/**
 * AUTHC-022 / VAL-01: append a new requirement to the domain's SPEC.json and
 * bump the envelope `updated:` to the local date. Reads the current
 * SPEC.json, `JSON.parse`s the envelope, pushes a requirement OBJECT
 * (`status: "active"`, statement/why from the fields, `livesIn` from `lives`),
 * then writes through the ONE `validateAndWrite` seam — never a bespoke
 * `Bun.write` of the domain file (the VAL-01 fence forbids it outside the
 * shared seam). The seam re-validates the WHOLE object (rejecting any injected
 * key, T-17-01) and serializes with the fixed key order + single trailing
 * newline. On a structural reject it prints the diagnostics and exits 2 (the
 * same INVALID_DOMAIN_FILE the index emits — VAL-02). Returns the
 * platform-relative spec path.
 *
 * NOTE the `binds` field has no home in the JSON requirement shape (STOR-01)
 * and is NOT persisted — the Markdown parser already ignored `Binds:`
 * (spec.ts:356). It still flows into `warnUnresolvableRefs` for @-ref
 * validation at the call sites. The signature is kept STABLE (same four args)
 * so `spec supersede` (17-05) composes.
 *
 * Shared by the interactive prompt flow and the L1 field-flag path.
 */
export async function appendEntry(
  platformDir: string,
  key: string,
  id: string,
  fields: { requirement: string; why: string; binds: string; lives: string },
): Promise<string> {
  const relFile = `spec-engine/${key}/SPEC.json`;
  const specPath = join(platformDir, "spec-engine", key, "SPEC.json");
  // Post-cutover (Phase 18, D2): SPEC.json is the ONLY spec format — the
  // Markdown read/seed path is deleted. Reading SPEC.json unconditionally
  // would reject with ENOENT and throw an unhandled rejection (a raw stack +
  // non-0/2 exit) for a domain that has no SPEC.json, so guard the read: a
  // domain with no SPEC.json is a clean typed error + exit 2 (the command's
  // 0/2 contract), never an ENOENT crash.
  const domain = existsSync(specPath)
    ? (JSON.parse(await Bun.file(specPath).text()) as {
        requirements?: unknown[];
        updated?: string;
        [k: string]: unknown;
      })
    : null;
  if (domain === null) {
    console.error(`spec req: no domain ${key} (expected ${relFile} under ${platformDir})`);
    process.exit(EXIT.USAGE);
  }
  const requirements = Array.isArray(domain.requirements) ? domain.requirements : [];
  requirements.push({
    id,
    status: "active",
    statement: fields.requirement,
    why: fields.why || null,
    supersedes: null,
    supersededBy: null,
    relates: [],
    livesIn: fields.lives ? [fields.lives] : [],
    issues: [],
  });
  domain.requirements = requirements;
  domain.updated = localToday();

  const res = await validateAndWrite(specPath, domain, relFile);
  if (!res.ok) {
    for (const diag of res.diagnostics) {
      console.error(`spec req: ${diag.detail}`);
    }
    process.exit(EXIT.USAGE);
  }
  return relFile;
}

/**
 * Read one line from stdin with the prompt rendered to STDERR (T-10-03 —
 * stdout stays machine-parseable). Pitfall 4 (10-01 precedent): rl.close()
 * in `finally`, NEVER inside the Promise executor. Exported for reuse by
 * `spec supersede` / `spec amend` TTY flows.
 */
export async function askLine(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await new Promise<string>((res) => rl.question(question, res));
  } finally {
    rl.close();
  }
}
