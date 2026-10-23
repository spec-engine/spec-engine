#!/usr/bin/env bun
// Checks the release workflow against its DIST requirements. The workflow
// carries no scannable @spec tag, so each check here is the tagged
// implementation and scripts/arch-fences.sh runs it.
//
// Usage: bun scripts/release-config.ts <publish-on-release|version-parity>

import { readFileSync } from "node:fs";
import { join } from "node:path";

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
export interface ReleaseFiles {
  workflow: Workflow;
}

const ENGINE = "packages/engine";
const ROOT = join(import.meta.dir, "..");

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

const CHECKS: Record<string, (f: ReleaseFiles) => string[]> = {
  "publish-on-release": checkPublishOnRelease,
  "version-parity": checkVersionParity,
};

export function loadReleaseFiles(): ReleaseFiles {
  return {
    workflow: Bun.YAML.parse(
      readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8"),
    ) as Workflow,
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
