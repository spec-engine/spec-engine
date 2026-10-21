// @spec RSLV-003

import { statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { FILES_MAX } from "@spec-engine/shared";
import { defineCommand, type ParsedArgs } from "citty";
import { EXIT, isExistingDir, OUT_HELP, resolveDbPath } from "../constants";
import { formatNoRequirementsIndexed } from "../indexer/discover";
import { maybePromptForOnboarding } from "../onboarding/prompt";
import { reqTags } from "../operations/reads";
import { renderReqTags, renderResolve } from "../resolve/format";
import { assertContainedPath, withReadStorage } from "./_shared";

// `--platformDir <dir>` and `--req <id>` consume a value slot too: without
// them here the value lands as a phantom file positional on the real argv.
const VALUE_FLAGS = new Set(["--out", "-o", "--platformDir", "--req"]);

type ArgKind = "push" | "skip" | "consume-next";

function classifyArg(a: string): ArgKind {
  if (a.startsWith("--")) {
    const eq = a.indexOf("=");
    const name = eq === -1 ? a : a.slice(0, eq);
    return VALUE_FLAGS.has(name) && eq === -1 ? "consume-next" : "skip";
  }
  if (a.startsWith("-") && a.length > 1) {
    return VALUE_FLAGS.has(a) ? "consume-next" : "skip";
  }
  return "push";
}

function extractPositionals(rawArgs: string[]): string[] {
  const positionals: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i] ?? "";
    const kind = classifyArg(a);
    if (kind === "consume-next") i += 1;
    else if (kind === "push") positionals.push(a);
  }
  return positionals;
}

/**
 * Citty declares two positionals (`files`, `platformDir`) and greedily binds
 * slot 2 of rawArgs to `args.platformDir`. For `spec resolve <f1> <f2>
 * <platformDir>` that binding is wrong, so the split is re-derived from a
 * stat of the last positional.
 */
function splitFilesAndPlatformDir(
  positionals: string[],
  fallbackPlatformDir: string | undefined,
): { files: string[]; platformDir: string | undefined } {
  if (positionals.length === 0) {
    return { files: [], platformDir: fallbackPlatformDir };
  }
  if (positionals.length === 1) {
    return { files: positionals, platformDir: fallbackPlatformDir };
  }
  const last = positionals[positionals.length - 1] ?? "";
  // The spec-engine/ check disambiguates against unrelated directories at
  // the same path. A directory without one is treated as a file, which
  // returns [] silently, so that case warns on stderr.
  let lastIsPlatformDir = false;
  let lastIsDirWithoutSpecEngine = false;
  try {
    const resolved = resolve(last);
    if (statSync(resolved).isDirectory()) {
      try {
        if (statSync(join(resolved, "spec-engine")).isDirectory()) {
          lastIsPlatformDir = true;
        } else {
          lastIsDirWithoutSpecEngine = true;
        }
      } catch {
        lastIsDirWithoutSpecEngine = true;
      }
    }
  } catch {
    lastIsPlatformDir = false;
  }
  if (lastIsPlatformDir) {
    return {
      files: positionals.slice(0, -1),
      platformDir: last,
    };
  }
  if (lastIsDirWithoutSpecEngine) {
    console.error(
      `spec resolve: ${last} is a directory but contains no spec-engine/; ` +
        "treating as file (use --platformDir to disambiguate)",
    );
  }
  return { files: positionals, platformDir: fallbackPlatformDir };
}

function commaSplit(values: string[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    for (const piece of v.split(",")) {
      const t = piece.trim();
      if (t) out.push(t);
    }
  }
  return out;
}

interface ReverseQueryOptions {
  reqId: string;
  platformDir: string;
  outArg: string | undefined;
  json: boolean;
  fresh: boolean;
  noPrompt: boolean | undefined;
}

async function runReverseQuery(opts: ReverseQueryOptions): Promise<void> {
  const { reqId, platformDir, outArg, json, fresh, noPrompt } = opts;
  const dbPath = resolveDbPath(platformDir, outArg);

  if (outArg) assertContainedPath(dbPath, platformDir, "spec resolve: --out");

  await maybePromptForOnboarding({ platformDir, args: { noPrompt } });

  await withReadStorage({ platformDir, dbPath, fresh, json }, (storage) => {
    const { rows, known } = reqTags(storage, reqId);
    if (rows.length === 0) {
      if (!known) {
        console.error(`spec resolve: no requirement ${reqId} in the index`);
      } else {
        console.error(`spec resolve: ${reqId} has no tags in any member repo`);
      }
    }
    console.log(renderReqTags(rows, json ? "json" : "text"));
  });
}

interface ResolvedFileArgs {
  files: string[];
  platformDir: string | undefined;
  positionals: string[];
  rawPD: string | undefined;
}

function resolveFileArgs(args: ResolveArgs, rawArgs: string[] | undefined): ResolvedFileArgs {
  const positionals = extractPositionals(rawArgs ?? []);
  // Citty lifts positional slot 1 into `args.platformDir` for
  // `spec resolve a.ts b.ts`, while the in-process harness sets it directly
  // with empty rawArgs. Trust it only when it is not one of the positionals.
  const rawPD = args.platformDir;
  const fallbackPD =
    rawPD === undefined
      ? undefined
      : (rawArgs ?? []).length === 0 || !positionals.includes(rawPD)
        ? rawPD
        : undefined;
  const split = splitFilesAndPlatformDir(positionals, fallbackPD);

  // The in-process test harness passes args directly with no rawArgs.
  let rawFiles: string[];
  if (positionals.length === 0) {
    const first = args.files;
    rawFiles = first ? [first] : [];
  } else {
    rawFiles = split.files;
  }
  return { files: commaSplit(rawFiles), platformDir: split.platformDir, positionals, rawPD };
}

/**
 * In-process callers set args.platformDir directly; on the real argv citty
 * binds a lone positional to args.files, so a single "file" that is the
 * platform dir is re-interpreted here.
 */
async function dispatchReverseQuery(
  reqArg: string,
  resolved: ResolvedFileArgs,
  args: ResolveArgs,
): Promise<void> {
  if (!/^[A-Z][A-Z0-9]*-\d+$/.test(reqArg)) {
    console.error(`spec resolve: --req must be a requirement id (KEY-NNN); got ${reqArg}`);
    process.exit(EXIT.USAGE);
  }
  // The citty-bound fields stand in for rawArgs on the in-process harness.
  const { positionals, rawPD } = resolved;
  const posnl =
    positionals.length > 0
      ? positionals
      : [args.files, rawPD].filter((x): x is string => typeof x === "string");
  const lone = posnl[0];
  // Defensive swallow: a user-supplied positional may be an odd path;
  // a hard stat failure (EACCES/ELOOP) here means "not the platform dir",
  // not a crash — unlike the discover/onboarding callers that let it throw.
  const loneIsDir =
    lone !== undefined &&
    (() => {
      try {
        return isExistingDir(lone);
      } catch {
        return false;
      }
    })();
  if (posnl.length > 1 || (lone !== undefined && !loneIsDir)) {
    console.error(
      "spec resolve: --req takes no file paths — it lists the files tagging the requirement. Pass at most a platform directory.",
    );
    process.exit(EXIT.USAGE);
  }
  await runReverseQuery({
    reqId: reqArg,
    platformDir: resolve(lone ?? process.cwd()),
    outArg: args.out,
    json: Boolean(args.json),
    fresh: Boolean(args.fresh),
    noPrompt: args.noPrompt,
  });
}

/**
 * Paths above platformDir are rejected rather than passed through: they
 * would never match the platform-relative `tags.file` and would silently
 * return [].
 */
function normalizeFileInputs(files: string[], platformDir: string): string[] {
  const normalized: string[] = [];
  for (const input of files) {
    const rel = relative(platformDir, resolve(platformDir, input));
    // Compare the first path segment against `..`, not the substring
    // `rel.startsWith("..")`, which over-rejects files like `..foo.ts` (as
    // api.ts hasTraversalSegment does). Empty or `.` is platformDir itself.
    const segments = rel.split(sep);
    if (rel === "" || rel === "." || segments[0] === "..") {
      console.error(`spec resolve: file path must be inside platformDir: ${input}`);
      process.exit(EXIT.USAGE);
    }
    normalized.push(rel);
  }
  return normalized;
}

const resolveArgs = {
  files: {
    type: "positional",
    required: true,
    description:
      "One or more file paths (platform-relative or absolute; comma-split also accepted in a single positional)",
  },
  platformDir: {
    type: "positional",
    required: false,
    description: "Platform directory containing spec-engine/ + members (default: cwd)",
  },
  req: {
    type: "string",
    description:
      "Reverse query: list every tag site (repo, file, line, kind, level) for the given requirement id instead of resolving files. Takes no file positionals.",
  },
  out: {
    type: "string",
    description: OUT_HELP,
  },
  json: {
    type: "boolean",
    description: "Emit requirements as JSON (deterministically sorted, no chrome)",
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
} as const;

type ResolveArgs = ParsedArgs<typeof resolveArgs>;

export const resolveCommand = defineCommand({
  meta: {
    name: "resolve",
    description:
      "Return the requirements tagged in the given files. Accepts multiple positional file paths (e.g. `spec resolve api/src/renew.ts api/src/charge.ts`) and a comma-split fallback inside a single positional (`spec resolve a.ts,b.ts`). Paths may be platform-relative or absolute under the platform tree.",
  },
  args: resolveArgs,
  async run({ args, rawArgs }) {
    const resolved = resolveFileArgs(args, rawArgs);
    const { files } = resolved;

    const reqArg = args.req;
    if (reqArg !== undefined) {
      await dispatchReverseQuery(reqArg, resolved, args);
      return;
    }

    if (files.length === 0) {
      console.error(
        "spec resolve: at least one file path required (e.g., spec resolve api/src/renew.ts)",
      );
      process.exit(EXIT.USAGE);
      return;
    }

    // The cap keeps `spec resolve $(huge-shell-expansion)` under
    // SQLITE_MAX_VARIABLE_NUMBER (32766) in storage.resolveByFiles.
    if (files.length > FILES_MAX) {
      console.error(
        `spec resolve: too many files (max ${FILES_MAX} per invocation; got ${files.length})`,
      );
      process.exit(EXIT.USAGE);
      return;
    }

    const platformDir = resolve(resolved.platformDir ?? process.cwd());
    const outArg = args.out;
    const dbPath = resolveDbPath(platformDir, outArg);

    if (outArg) assertContainedPath(dbPath, platformDir, "spec resolve: --out");

    const normalized = normalizeFileInputs(files, platformDir);

    // No `ci` arg: only `check` registers `--ci`.
    await maybePromptForOnboarding({
      platformDir,
      args: {
        noPrompt: args.noPrompt,
      },
    });

    await withReadStorage(
      { platformDir, dbPath, fresh: !!args.fresh, json: !!args.json },
      (storage) => {
        const rows = storage.resolveByFiles(normalized);
        // A platform with no requirements at all gets first-spec guidance
        // instead of an empty table. Text mode only: JSON consumers depend
        // on "[]" on stdout.
        if (!args.json && rows.length === 0 && storage.listRequirements().length === 0) {
          console.error(formatNoRequirementsIndexed(platformDir));
          return;
        }
        const output = renderResolve(rows, args.json ? "json" : "text");
        console.log(output);
      },
    );
  },
});
