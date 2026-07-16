// packages/engine/src/commands/init.ts
//
// Dogfood (spec self-consumes this repo — see spec-engine/):
// @spec INIT-001
// @spec INIT-002
// @spec INIT-003
// @spec INIT-004
// @spec INIT-013
//
// INIT-01..06, INIT-08..11, INIT-14: spec init scaffolder.
//
// Behaviors (referenced to RESEARCH § Patterns and Pitfalls):
//   1. Default REPO to cwd (INIT-01) — resolve()
//   2. existsSync + isDirectory guard BEFORE realpathSync (Pitfall 2)
//   3. realpathSync + segment containment refusal (INIT-02 / Pattern 1)
//      Catches all 4 PITFALLS Pitfall 5 cases: basename, nested, symlink, cwd
//   4. detectContext(canonical) → platform refusal (INIT-14)
//      OR pin source via the DERIVED platform version (RED-85: max domain
//      version — the authored spec-engine.platform.json manifest is retired)
//   5. --specs Zod validation via shared SpecConfigSchema (INIT-05)
//   6. Existing config: no-force prints + exit 0 (INIT-03); --force runs raw
//      Object.keys shape-safety (Pattern 3 / Pitfall 3 — NEVER through Zod)
//   7. Write via Bun.write with trailing newline (INIT-09 / Pitfall 6)
//      Deliberate divergence from new.ts:97 writeFileSync technical debt
//   8. stdout: absolute path + pin + pin source (INIT-10)
//   9. Exit codes: 0 (scaffolded), 0 (already configured), 2 (every failure).
//      NEVER exit 1 — reserved for spec check --ci semantic failures (INIT-11).
//
// HARD CONSTRAINT (D-08): this file does NOT import bun:sqlite.
//
// STRUCTURE: `run` is a linear pipeline of named validators/stages, each of
// which returns a discriminated `{ ok: true; … } | { ok: false; message }`
// (or a small tagged outcome) so `run` owns the single console.error +
// process.exit(EXIT.USAGE) per failure. This keeps every function's cognitive
// complexity ≤15 with no behavior change: same stdout/stderr, same exit codes.

import { existsSync, realpathSync, statSync } from "node:fs"; // existsSync retained for spec-engine.member.json existence check (inspectExistingConfig)
import { join, resolve, sep } from "node:path";
import { SpecConfigSchema } from "@spec-engine/shared";
import { defineCommand } from "citty";
import { EXIT } from "../constants";
import { readRepoConfig, warnIfRetiredManifest } from "../indexer/discover";
import { detectContext } from "../onboarding/context";

/** Error → message coercion shared by every guard's failure path. */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Resolve REPO (default cwd) — INIT-01.
 * WR-08: shape-check args.repo before resolve() instead of an unchecked cast.
 * citty normally produces string|undefined here, but programmatic callers
 * (other commands invoking initCommand.run) could pass a non-string and
 * resolve() would throw a TypeError outside the INIT-11 graceful-exit envelope.
 */
function resolveRepoArg(repoRaw: unknown): string {
  const repoArg = typeof repoRaw === "string" && repoRaw.length > 0 ? repoRaw : process.cwd();
  return resolve(repoArg);
}

/**
 * Fuse the INIT-01 existence/directory guard with the INIT-02 realpath +
 * segment-containment refusal, returning a discriminated result so `run` owns
 * the single console.error + exit.
 *
 * The existence + directory guard MUST happen BEFORE realpathSync because
 * realpathSync throws ENOENT on missing paths (Pitfall 2). WR-01: single
 * statSync({throwIfNoEntry:false}) eliminates the existsSync+statSync TOCTOU
 * window and swallows ENOENT cleanly. We still wrap realpathSync separately
 * because EACCES / ELOOP can fire from realpathSync on a path that statSync
 * accepted.
 * RED-14: throwIfNoEntry only swallows ENOENT — statSync itself throws ELOOP
 * on a symlink cycle (`loop -> loop`) and EACCES on an unreadable path
 * component. Both used to escape as raw stack traces; wrap to honor the
 * INIT-11 exit-2 contract here too.
 *
 * INIT-02 path-safety: realpathSync resolves symlinks (Pitfall 5 — e.g. macOS
 * /tmp → /private/tmp), then segment containment. "spec-engine" anywhere as a
 * path segment of the canonical path triggers refusal — basename match catches
 * only 1 of 4 PITFALLS cases (Pattern 1). WR-01: realpathSync can throw ENOENT
 * (TOCTOU: dir unlinked between statSync and here), EACCES, or ELOOP. Wrap to
 * honor the INIT-11 exit-2 contract rather than leaking a stack trace.
 */
function canonicalizeRepo(
  absRepo: string,
): { ok: true; canonical: string } | { ok: false; message: string } {
  let repoStat: ReturnType<typeof statSync>;
  try {
    repoStat = statSync(absRepo, { throwIfNoEntry: false });
  } catch (err) {
    return { ok: false, message: `spec init: cannot resolve ${absRepo}: ${errMessage(err)}` };
  }
  if (!repoStat?.isDirectory()) {
    return { ok: false, message: `spec init: ${absRepo} does not exist or is not a directory` };
  }

  let canonical: string;
  try {
    canonical = realpathSync(absRepo);
  } catch (err) {
    return { ok: false, message: `spec init: cannot resolve ${absRepo}: ${errMessage(err)}` };
  }
  const segments = canonical.split(sep).filter((s) => s.length > 0);
  if (segments.includes("spec-engine")) {
    return {
      ok: false,
      message: `spec init: ${absRepo} resolves to ${canonical}, which is inside a spec-engine/ tree — refusing to scaffold there.`,
    };
  }
  return { ok: true, canonical };
}

type Context = Awaited<ReturnType<typeof detectContext>>;

/**
 * detectContext consumes Plan 09-01's substrate. INIT-14 (platform refusal) AND
 * the pin source from the derived platform version (RED-85). Wrapped in
 * try/catch — an fs-level throw (EACCES/ELOOP) still exits 2 gracefully.
 * INIT-14: REPO is itself a platform dir (contains spec-engine/) → refuse.
 */
async function resolveContext(
  canonical: string,
): Promise<{ ok: true; ctx: Context } | { ok: false; message: string }> {
  let ctx: Context;
  try {
    ctx = await detectContext(canonical);
  } catch (err) {
    return { ok: false, message: `spec init: ${errMessage(err)}` };
  }
  if (ctx.kind === "platform") {
    return {
      ok: false,
      message: `spec init: ${canonical} is a platform dir (contains spec-engine/) — pass a member subdir or cd into one`,
    };
  }
  return { ok: true, ctx };
}

/**
 * Pin resolution. --specs flag wins; else the derived platform version from
 * detectContext (max domain version — RED-85); else fallback @1 with stdout
 * note (INIT-06).
 * WR-04: gate on (string AND non-empty) rather than `!== undefined`. An empty
 * string is not undefined, but routing it through Zod just yields a generic
 * "expected string" error that doesn't reflect the real shape problem. Keeping
 * this gate aligned with the WR-08 repoArg shape-check.
 */
function resolvePin(
  specsArg: unknown,
  ctx: Context,
  json: boolean | undefined,
): { ok: true; pin: string; pinSource: string } | { ok: false; message: string } {
  if (typeof specsArg === "string" && specsArg.length > 0) {
    try {
      const validated = SpecConfigSchema.parse({ specs: specsArg });
      return { ok: true, pin: validated.specs, pinSource: "--specs flag" };
    } catch (err) {
      return { ok: false, message: `spec init: --specs validation failed: ${errMessage(err)}` };
    }
  }
  if (specsArg === "") {
    // WR-04: explicit empty-string rejection so the user sees a clear message
    // rather than a generic Zod "expected string".
    return {
      ok: false,
      message:
        "spec init: --specs validation failed: value must be of the form spec-engine@N (got empty string)",
    };
  }
  if (ctx.platformVersion !== null && ctx.platformDir !== null) {
    warnIfRetiredManifest(ctx.platformDir, ctx.platformVersion);
    return {
      ok: true,
      pin: `spec-engine@${ctx.platformVersion}`,
      pinSource: `derived platform version (max domain version ${ctx.platformVersion} at ${ctx.platformDir})`,
    };
  }
  // WR-02: fallback is a SUCCESS path (exit 0). Emitting the note to stderr made
  // CI pipelines that treat any stderr write as failure flake unnecessarily. The
  // note is part of the human-readable source-line breakdown, so it belongs
  // alongside the rest of the INIT-10 stdout summary. T4: suppressed under
  // --json — the `source` field carries the same information and stdout must
  // stay one object.
  if (!json) {
    console.log("spec init: no platform spec-engine/ found upward — falling back to spec-engine@1");
  }
  return { ok: true, pin: "spec-engine@1", pinSource: "fallback @1" };
}

/**
 * Read + parse an existing config as a raw object. Pitfall 3: do NOT route
 * through SpecConfigSchema.parse here (z.object default strip would mask
 * forward-compat fields) — this raw read backs both the no-force and --force
 * shape inspections.
 */
async function readRawConfigObject(
  configPath: string,
): Promise<{ ok: true; raw: Record<string, unknown> } | { ok: false; message: string }> {
  let existingText: string;
  try {
    existingText = await Bun.file(configPath).text();
  } catch (err) {
    return {
      ok: false,
      message: `spec init: existing ${configPath} could not be read: ${errMessage(err)}`,
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(existingText);
  } catch (err) {
    return {
      ok: false,
      message: `spec init: existing ${configPath} failed to parse: ${errMessage(err)}`,
    };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, message: `spec init: existing ${configPath} is not a JSON object` };
  }
  return { ok: true, raw: raw as Record<string, unknown> };
}

/**
 * INIT-03 no-op emit: validate via the same Zod-checked path the indexer uses
 * (One Engine — readRepoConfig from indexer/discover.ts) to surface the same
 * pin-shape errors users see at index time, then print the "already configured"
 * summary. T4: --json emits one object; extra_fields carries the WR-05
 * visibility signal that the text mode renders as a warning line.
 */
async function emitAlreadyConfigured(
  configPath: string,
  extraKeys: string[],
  hasExtraFields: boolean,
  json: boolean | undefined,
): Promise<{ ok: true } | { ok: false; message: string }> {
  let existing: { specs: string };
  try {
    existing = await readRepoConfig(configPath);
  } catch (err) {
    return { ok: false, message: `spec init: ${errMessage(err)}` };
  }
  if (json) {
    console.log(
      JSON.stringify({
        action: "already-configured",
        path: configPath,
        pin: existing.specs,
        extra_fields: extraKeys,
      }),
    );
    return { ok: true };
  }
  console.log("spec init: already configured");
  console.log(`  path: ${configPath}`);
  console.log(`  pin:  ${existing.specs}`);
  if (hasExtraFields) {
    // WR-05 visibility: warn (stdout, not stderr — existing config is working
    // so this is success-with-info) that --force would refuse and direct the
    // user to edit manually before retrying.
    console.log(
      `  warning: file has extra fields (${extraKeys.join(", ")}); --force would refuse to overwrite. Edit manually if you intend to re-run with --force.`,
    );
  }
  return { ok: true };
}

/**
 * T7: --force rewrites the PIN, never the user's ignore list — carry a valid
 * existing `ignore` forward into the rewritten body. An invalid value (wrong
 * type, empty entries) refuses the same way an unknown key does: overwriting it
 * would destroy user data.
 */
function resolvePreservedIgnore(
  configPath: string,
  raw: Record<string, unknown>,
): { ok: true; ignore?: string[] } | { ok: false; message: string } {
  const rawIgnore = raw.ignore;
  if (rawIgnore === undefined) return { ok: true };
  if (!Array.isArray(rawIgnore) || !rawIgnore.every((e) => typeof e === "string" && e.length > 0)) {
    return {
      ok: false,
      message: `spec init: existing ${configPath} has an invalid ignore field (expected an array of non-empty strings); refusing to overwrite. Edit manually.`,
    };
  }
  return { ok: true, ignore: rawIgnore as string[] };
}

type InspectOutcome =
  | { kind: "handled" } // no-force already emitted its summary; run returns (exit 0)
  | { kind: "proceed"; preservedIgnore?: string[] } // continue to write
  | { kind: "error"; message: string }; // run prints stderr + exit 2

/**
 * Existing-config branch — INIT-03 (no-force no-op) OR INIT-04 (--force raw-keys
 * shape-safety; Pitfall 3 lock — NEVER through Zod's strip mode).
 *
 * WR-05: the raw Object.keys shape check runs on BOTH paths. Previously only
 * --force triggered it; the no-force path used readRepoConfig (Zod .strip())
 * which silently dropped extra fields. So a user who ran `spec init` (no-force,
 * "already configured" — looks fine), then later `spec init --force` (refusal —
 * extra fields) saw inconsistent behavior. Now both paths inspect the raw shape;
 * the no-force path prints a stdout warning if extras exist but still treats
 * this as "already configured" (exit 0) so users get visibility WITHOUT a hard
 * refusal of a working state.
 */
async function inspectExistingConfig(
  configPath: string,
  force: boolean | undefined,
  json: boolean | undefined,
): Promise<InspectOutcome> {
  if (!existsSync(configPath)) return { kind: "proceed" };

  const rawRes = await readRawConfigObject(configPath);
  if (!rawRes.ok) return { kind: "error", message: rawRes.message };
  const { raw } = rawRes;

  // T7: `ignore` is a first-class field (SpecConfigSchema), not an "extra" —
  // only keys outside the known set trip the warning/refusal.
  const KNOWN_KEYS = new Set(["specs", "ignore"]);
  const extraKeys = Object.keys(raw).filter((k) => !KNOWN_KEYS.has(k));
  const hasExtraFields = extraKeys.length > 0;

  if (!force) {
    const res = await emitAlreadyConfigured(configPath, extraKeys, hasExtraFields, json);
    return res.ok ? { kind: "handled" } : { kind: "error", message: res.message };
  }

  // INIT-04 --force shape-safety: refuse on extra fields. This is a hard refusal
  // because --force is explicit user intent to overwrite, and silently dropping
  // forward-compat keys would destroy user data.
  if (hasExtraFields) {
    return {
      kind: "error",
      message: `spec init: existing ${configPath} has extra fields (${extraKeys.join(", ")}); refusing to overwrite. Edit manually.`,
    };
  }
  const ignoreRes = resolvePreservedIgnore(configPath, raw);
  if (!ignoreRes.ok) return { kind: "error", message: ignoreRes.message };
  // Fall through to write — existing has exactly the shape we'd produce.
  return { kind: "proceed", preservedIgnore: ignoreRes.ignore };
}

/**
 * INIT-09 write: pretty-printed JSON + mandatory trailing newline (Pitfall 6).
 * Bun.write — INIT-09 mandate; deliberate divergence from new.ts:97
 * writeFileSync technical debt.
 * INIT-10 stdout: absolute path + pin + pin source. Three lines, "spec init:"
 * prefix on the headline (universal command-error convention across new.ts /
 * id.ts / check.ts). T4: --json renders the same three facts as one object.
 */
async function writeConfigAndEmit(
  configPath: string,
  pin: string,
  pinSource: string,
  preservedIgnore: string[] | undefined,
  json: boolean | undefined,
): Promise<void> {
  const body = `${JSON.stringify(
    preservedIgnore !== undefined ? { specs: pin, ignore: preservedIgnore } : { specs: pin },
    null,
    2,
  )}\n`;
  await Bun.write(configPath, body);

  if (json) {
    console.log(JSON.stringify({ action: "wrote", path: configPath, pin, source: pinSource }));
    return;
  }
  console.log(`spec init: wrote ${configPath}`);
  console.log(`  pin:    ${pin}`);
  console.log(`  source: ${pinSource}`);
}

export const initCommand = defineCommand({
  meta: {
    name: "init",
    description: "Scaffold spec-engine.member.json into a member repo",
  },
  args: {
    repo: {
      type: "positional",
      required: false,
      description: "Member repo directory (default: cwd)",
    },
    specs: {
      type: "string",
      description: "Pin override (e.g. spec-engine@2). Validated via SpecConfigSchema.",
    },
    force: {
      type: "boolean",
      description:
        "Overwrite an existing spec-engine.member.json (refuses if existing has extra keys).",
    },
    json: {
      type: "boolean",
      description:
        "Print the outcome as one JSON object ({action, path, pin, …}). Errors stay text-on-stderr + exit 2.",
    },
  },
  async run({ args }) {
    // 1. Resolve REPO (default cwd) — INIT-01 / WR-08.
    const absRepo = resolveRepoArg(args.repo);

    // 2+3. Existence/directory guard + realpath containment refusal (INIT-02).
    const canon = canonicalizeRepo(absRepo);
    if (!canon.ok) {
      console.error(canon.message);
      process.exit(EXIT.USAGE);
      return;
    }
    const { canonical } = canon;

    // 4. detectContext + platform refusal (INIT-14 / INIT-08).
    const ctxRes = await resolveContext(canonical);
    if (!ctxRes.ok) {
      console.error(ctxRes.message);
      process.exit(EXIT.USAGE);
      return;
    }

    // 5. Pin resolution (INIT-06 / INIT-05 / WR-02 / WR-04).
    const pinRes = resolvePin(args.specs, ctxRes.ctx, args.json);
    if (!pinRes.ok) {
      console.error(pinRes.message);
      process.exit(EXIT.USAGE);
      return;
    }
    const { pin, pinSource } = pinRes;

    // 6. Existing-config branch — INIT-03 / INIT-04 (Pitfall 3 raw-shape lock).
    const configPath = join(canonical, "spec-engine.member.json");
    const inspect = await inspectExistingConfig(configPath, args.force, args.json);
    if (inspect.kind === "error") {
      console.error(inspect.message);
      process.exit(EXIT.USAGE);
      return;
    }
    if (inspect.kind === "handled") return;

    // 7+8. Write (INIT-09) + stdout/--json emit (INIT-10).
    await writeConfigAndEmit(configPath, pin, pinSource, inspect.preservedIgnore, args.json);
    // 9. Clean return → citty calls process.exit(0).
  },
});
