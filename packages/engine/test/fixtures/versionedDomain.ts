// packages/engine/test/fixtures/versionedDomain.ts
//
// RED-85 helper: write a minimal, schema-valid domain SPEC.json whose
// DAG-derived version (1 + supersede edges — SCHM-007) equals `version`.
// The derived-platform-version tests (onboarding-context / discover /
// cli-init) scaffold domains through this now that the authored
// spec-engine.platform.json manifest is retired: to give a tmp platform
// version N, plant a domain with N-1 supersede edges — never a counter file.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Zero-pad a requirement sequence number to the KEY-NNN convention. */
const seq = (n: number): string => String(n).padStart(3, "0");

/**
 * Write `spec-engine/<key>/SPEC.json` under `platformDir` containing
 * `version - 1` superseded requirements (each one supersede edge) plus one
 * active successor, so `deriveDomainVersion` — and therefore the derived
 * platform version when this is the highest domain — equals `version`.
 */
export async function writeVersionedDomain(
  platformDir: string,
  key: string,
  version: number,
): Promise<void> {
  const dir = join(platformDir, "spec-engine", key);
  await mkdir(dir, { recursive: true });
  const requirements: unknown[] = [];
  for (let i = 1; i < version; i++) {
    requirements.push({
      id: `${key}-${seq(i)}`,
      status: "superseded",
      statement: `retired promise ${i} of the ${key} fixture domain`,
      supersededBy: `${key}-${seq(version)}`,
    });
  }
  requirements.push({
    id: `${key}-${seq(version)}`,
    status: "active",
    statement: `current promise of the ${key} fixture domain`,
  });
  await writeFile(
    join(dir, "SPEC.json"),
    `${JSON.stringify({ key, owner: null, updated: "2026-01-01", requirements }, null, 2)}\n`,
  );
}
