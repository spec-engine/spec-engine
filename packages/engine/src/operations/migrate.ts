import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import {
  type Diagnostic,
  DiagnosticCode,
  SCHEMA_URLS,
  validateAndWrite,
} from "@spec-engine/shared";
import { listDomainKeys } from "../authoring/domains";
import { CHECK_CONFIG_REL, readCheckConfig } from "../check/severity";
import { MEMBER_CONFIG_FILENAME, specPaths } from "../constants";
import { discoverRepos, readRepoConfig } from "../indexer/discover";
import { readEnvelope } from "./_envelope";
import { fail, type OpFailure } from "./_result";

// An escaped quote inside a JSON string is preceded by a backslash, so
// statement text that mentions a key name never matches.
const LEGACY_KEY_RE = /(?<!\\)"(?:livesIn|verifiedIn)"\s*:/;
const SCHEMA_KEY_RE = /(?<!\\)"\$schema"\s*:/;

export interface MigrateResult {
  ok: true;
  /** Platform-relative paths rewritten: SPEC.json files in key order, then check.json, then member configs. */
  files: string[];
}

type FileKind = "spec" | "check" | "member";

interface PendingFile {
  kind: FileKind;
  abs: string;
  rel: string;
  /** Domain key; set for a SPEC.json only. */
  key?: string;
  legacy: boolean;
  noSchema: boolean;
}

/** Every SPEC.json, the check.json, and every member config, in that order; absent files are skipped. */
async function candidateFiles(
  platformDir: string,
): Promise<Omit<PendingFile, "legacy" | "noSchema">[]> {
  const out: Omit<PendingFile, "legacy" | "noSchema">[] = listDomainKeys(platformDir).map(
    (key) => ({
      kind: "spec",
      key,
      ...specPaths(platformDir, key),
    }),
  );
  const checkAbs = join(platformDir, CHECK_CONFIG_REL);
  if (existsSync(checkAbs)) out.push({ kind: "check", abs: checkAbs, rel: CHECK_CONFIG_REL });
  const { members } = await discoverRepos(platformDir, { quiet: true });
  const memberConfigs = new Set(members.map((m) => join(m.path, MEMBER_CONFIG_FILENAME)));
  for (const abs of [...memberConfigs].sort()) {
    if (existsSync(abs)) out.push({ kind: "member", abs, rel: relative(platformDir, abs) });
  }
  return out;
}

/** The files a `spec migrate` run would rewrite. A missing or unreadable file is another check's finding. */
async function pendingFiles(platformDir: string): Promise<PendingFile[]> {
  const pending: PendingFile[] = [];
  for (const file of await candidateFiles(platformDir)) {
    const raw = await Bun.file(file.abs)
      .text()
      .catch(() => "");
    if (raw === "") continue;
    const legacy = file.kind === "spec" && LEGACY_KEY_RE.test(raw);
    const noSchema = !SCHEMA_KEY_RE.test(raw);
    if (legacy || noSchema) pending.push({ ...file, legacy, noSchema });
  }
  return pending;
}

function pendingDetail(file: PendingFile): string {
  const found: string[] = [];
  const fixes: string[] = [];
  if (file.legacy) {
    found.push("still carries the retired livesIn or verifiedIn fields");
    fixes.push("strip them");
  }
  if (file.noSchema) {
    found.push("has no $schema key");
    fixes.push(`add ${SCHEMA_URLS[file.kind]}`);
  }
  return `${file.rel} ${found.join(" and ")}; run spec migrate to ${fixes.join(" and ")}`;
}

/**
 * One MIGRATION_PENDING warning per file that still carries a retired key or
 * lacks the `$schema` key, the detail naming which.
 * @spec CHCK-054
 * @spec CHCK-063
 */
export async function migrationPendingDiagnostics(platformDir: string): Promise<Diagnostic[]> {
  return (await pendingFiles(platformDir)).map((file) => ({
    code: DiagnosticCode.MIGRATION_PENDING,
    severity: "warning",
    repo: null,
    source_file: file.rel,
    line: null,
    req_id: null,
    detail: pendingDetail(file),
  }));
}

/** `text` with a `$schema` key inserted as the first key of its top-level object; every other byte kept. */
function withSchemaKey(text: string, url: string): string {
  const empty = /^\s*\{\s*\}/.test(text);
  return text.replace(
    /^\s*\{/,
    () => `{\n  "$schema": ${JSON.stringify(url)}${empty ? "\n" : ","}`,
  );
}

async function migrateDomain(platformDir: string, key: string): Promise<OpFailure | null> {
  const file = await readEnvelope(platformDir, key);
  if (!file.ok) return file;
  const domain = { ...file.domain, $schema: file.domain.$schema ?? SCHEMA_URLS.spec };
  const res = await validateAndWrite(file.specPath, domain, file.relFile);
  if (res.ok) return null;
  return fail("invalid_domain_file", res.diagnostics.map((d) => d.detail).join("\n"), {
    diagnostics: res.diagnostics,
  });
}

/** Refuses a config that fails its own schema, so the insert never lands in a broken file. */
async function migrateConfig(platformDir: string, file: PendingFile): Promise<OpFailure | null> {
  if (file.kind === "check") {
    const read = readCheckConfig(platformDir);
    if (!read.ok) return fail("usage", read.detail);
  } else {
    try {
      await readRepoConfig(file.abs);
    } catch (err) {
      return fail("conflict", err instanceof Error ? err.message : String(err));
    }
  }
  await Bun.write(file.abs, withSchemaKey(await Bun.file(file.abs).text(), SCHEMA_URLS[file.kind]));
  return null;
}

/**
 * The parse has already dropped both retired keys, so the raw text decides
 * which files carry them; the write seam does the stripping and puts a new
 * `$schema` key first.
 * @spec SCHM-039
 * @spec SCHM-048
 */
export async function migrate(platformDir: string): Promise<MigrateResult | OpFailure> {
  const files: string[] = [];
  for (const file of await pendingFiles(platformDir)) {
    const failure =
      file.key === undefined
        ? await migrateConfig(platformDir, file)
        : await migrateDomain(platformDir, file.key);
    if (failure) return failure;
    files.push(file.rel);
  }
  return { ok: true, files };
}
