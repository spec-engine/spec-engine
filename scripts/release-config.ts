#!/usr/bin/env bun
// Checks the release pipeline's config against its DIST requirements. The
// workflow and the JSON configs carry no scannable @spec tag, so each check
// here is the tagged implementation and scripts/arch-fences.sh runs it.
//
// Usage: bun scripts/release-config.ts <DIST-015|DIST-016|DIST-017|DIST-018>

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";

interface Step {
  uses?: string;
  run?: string;
  with?: Record<string, string>;
  env?: Record<string, string>;
}
interface Job {
  if?: string;
  needs?: string[];
  permissions?: Record<string, string>;
  steps?: Step[];
}
export interface Workflow {
  on: { push?: { branches?: string[]; tags?: string[] } };
  jobs: Record<string, Job>;
}
type Deps = Record<string, string>;
export interface Manifest {
  dependencies?: Deps;
  devDependencies?: Deps;
  optionalDependencies?: Deps;
}
export interface ReleaseFiles {
  workflow: Workflow;
  rpConfig: { packages?: Record<string, Record<string, unknown>> };
  rpManifest: Record<string, string>;
  engineVersion: string;
  renovate: { extends?: string[] };
  manifests: Record<string, Manifest>;
}

const ENGINE = "packages/engine";
const ROOT = join(import.meta.dir, "..");

export function checkReleasePr(f: ReleaseFiles): string[] {
  const out: string[] = [];
  const job = f.workflow.jobs["release-please"];
  if (!job) return ["ci.yml has no release-please job"];
  if (job.if !== "github.event_name == 'push' && github.ref == 'refs/heads/main'") {
    out.push("release-please must run on push to main only");
  }
  const step = job.steps?.find((s) => s.uses?.startsWith("googleapis/release-please-action@v4"));
  if (step?.with?.["config-file"] !== "release-please-config.json") {
    out.push(
      "release-please must run googleapis/release-please-action@v4 with release-please-config.json",
    );
  }
  if (step?.with?.["manifest-file"] !== ".release-please-manifest.json") {
    out.push("release-please must read .release-please-manifest.json");
  }
  const pkg = f.rpConfig.packages?.[ENGINE];
  if (
    pkg?.["release-type"] !== "node" ||
    pkg["package-name"] !== "@spec-engine/spec-engine" ||
    pkg["include-component-in-tag"] !== false
  ) {
    out.push(
      `release-please-config.json must release ${ENGINE} as node, @spec-engine/spec-engine, v<version> tags`,
    );
  }
  if (f.rpManifest[ENGINE] !== f.engineVersion) {
    out.push(
      `.release-please-manifest.json ${f.rpManifest[ENGINE]} != ${ENGINE} version ${f.engineVersion}`,
    );
  }
  return out;
}

/** @spec DIST-024 */
export function checkPublishOnRelease(f: ReleaseFiles): string[] {
  const out: string[] = [];
  const job = f.workflow.jobs.publish;
  if (!job) return ["ci.yml has no publish job"];
  const gates = Object.keys(f.workflow.jobs).filter(
    (j) => j !== "publish" && j !== "release-please",
  );
  const cond = job.if ?? "";
  for (const g of gates) {
    if (!job.needs?.includes(g)) out.push(`publish must need gate job ${g}`);
    if (!cond.includes(`needs.${g}.result == 'success'`))
      out.push(`publish must require ${g} to succeed`);
  }
  if (!job.needs?.includes("release-please")) out.push("publish must need release-please");
  for (const t of [
    "!cancelled()",
    "startsWith(github.ref, 'refs/tags/v')",
    "needs.release-please.outputs.release_created == 'true'",
  ]) {
    if (!cond.includes(t)) out.push(`publish condition must include ${t}`);
  }
  if (!f.workflow.on.push?.tags?.includes("v*")) out.push("ci.yml must run on v* tag pushes");
  if (job.permissions?.["id-token"] !== "write")
    out.push("publish must hold id-token: write for OIDC");
  if (!job.steps?.some((s) => s.run?.includes("npm publish")))
    out.push("publish must run npm publish");
  return out;
}

/** @spec DIST-024 */
export function checkVersionParity(f: ReleaseFiles): string[] {
  const steps = f.workflow.jobs.publish?.steps ?? [];
  const parity = steps.findIndex(
    (s) =>
      s.env?.RELEASE_TAG?.includes("needs.release-please.outputs.tag_name") &&
      s.env.RELEASE_TAG.includes("github.ref_name") &&
      s.run?.includes(`${ENGINE}/package.json`),
  );
  const pack = steps.findIndex((s) => s.run?.includes("bun pm pack"));
  if (parity === -1) return ["publish has no tag-to-package version parity step"];
  if (pack === -1 || parity > pack) return ["the version parity step must run before packing"];
  return [];
}

const EXACT = /^(\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?|workspace:\*)$/;

export function checkExactPins(f: ReleaseFiles): string[] {
  const out: string[] = [];
  for (const [file, m] of Object.entries(f.manifests)) {
    for (const deps of [m.dependencies, m.devDependencies, m.optionalDependencies]) {
      for (const [name, range] of Object.entries(deps ?? {})) {
        if (!EXACT.test(range)) out.push(`${file}: ${name}@${range} is not an exact pin`);
      }
    }
  }
  if (!f.renovate.extends?.includes(":pinAllExceptPeerDependencies")) {
    out.push("renovate.json must extend :pinAllExceptPeerDependencies");
  }
  return out;
}

const CHECKS: Record<string, (f: ReleaseFiles) => string[]> = {
  "DIST-015": checkReleasePr,
  "DIST-016": checkPublishOnRelease,
  "DIST-017": checkVersionParity,
  "DIST-018": checkExactPins,
};

function json<T>(path: string): T {
  return JSON.parse(readFileSync(join(ROOT, path), "utf8")) as T;
}

export function loadReleaseFiles(): ReleaseFiles {
  const manifests: Record<string, Manifest> = {};
  for (const file of new Glob(
    "{package.json,packages/*/package.json,scripts/package.json}",
  ).scanSync(ROOT)) {
    manifests[file] = json<Manifest>(file);
  }
  return {
    workflow: Bun.YAML.parse(
      readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8"),
    ) as Workflow,
    rpConfig: json("release-please-config.json"),
    rpManifest: json(".release-please-manifest.json"),
    engineVersion: json<{ version: string }>(`${ENGINE}/package.json`).version,
    renovate: json("renovate.json"),
    manifests,
  };
}

if (import.meta.main) {
  const id = process.argv[2] ?? "";
  const check = CHECKS[id];
  if (!check) {
    console.error(`usage: bun scripts/release-config.ts <${Object.keys(CHECKS).join("|")}>`);
    process.exit(2);
  }
  const problems = check(loadReleaseFiles());
  for (const p of problems) console.log(`FAIL: ${p}`);
  if (problems.length > 0) process.exit(1);
  console.log(`${id} release config: OK`);
}
