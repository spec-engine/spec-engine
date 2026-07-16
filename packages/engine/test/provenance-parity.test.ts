// packages/engine/test/provenance-parity.test.ts
//
// Phase 16 Plan 02 / Task 2 (PWEB-02 / PWEB-03) — parity-by-construction proof:
// the CLI `spec provenance --resolve-issues` text and the webapp `/provenance`
// page render through the SAME engine decorator (renderProvenanceDecorated), so
// the two surfaces cannot drift.
//
// Harness composes mountApi(app, storage, clone) + mountWebapp(app) on one Hono
// instance (TEST-ONLY engine import — production webapp source is hermetic). The
// page reads the `/api/provenance?resolve=1` decorated-text seam in-process; the
// CLI side calls renderProvenanceDecorated directly over the SAME rows + the SAME
// degraded resolved map. With no SPEC_TRACKER_TOKEN both degrade identically
// (PWEB-03), so every decorated link line the CLI emits must appear, escaped, in
// the page body.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ProvenanceMatrixRow, Storage } from "@spec-engine/shared";
import { mountWebapp } from "@spec-engine/webapp/server";
import { Hono } from "hono";
import { runIndex } from "../src/indexer/pipeline";
import { type ResolvedShape, renderProvenanceDecorated } from "../src/provenance/format";
import { resolveAndCache } from "../src/provenance/resolve";
import { mountApi } from "../src/server/api";
import { openStorage } from "../src/storage/sqlite";
import { cloneFixture } from "./fixtures/cloneFixture";

const FIXTURE = resolve(import.meta.dir, "..", "..", "..", "fixtures", "platform-fixture");

let clone: string;
let storage: Storage;

beforeAll(async () => {
  clone = cloneFixture(FIXTURE);
  rmSync(join(clone, ".spec-engine"), { recursive: true, force: true });
  storage = openStorage(join(clone, ".spec-engine", "index.sqlite"));
  await runIndex({ platformDir: clone, storage });
});

afterAll(() => {
  storage.close();
  rmSync(clone, { recursive: true, force: true });
});

function buildApp(): Hono {
  const app = new Hono();
  mountApi(app, storage, clone);
  mountWebapp(app);
  return app;
}

/**
 * The link lines (indented `  <role>  <issue_id>  ...`) of the CLI decorated
 * text — these are the per-requirement provenance lines that must appear,
 * escaped, in the webapp page body. (Requirement header lines like
 * `BILLING-009  [Active]  tests: ...` also appear, but the link lines carry the
 * decorated overlay/degradation that proves parity.)
 */
function linkLines(decoratedText: string): string[] {
  return decoratedText.split("\n").filter((l) => l.startsWith("  "));
}

// PARKED while the webapp /provenance route is flag-gated off
// (PROVENANCE_ENABLED=false in packages/webapp/src/pages/provenance.ts → the
// page renders a coming-soon placeholder, not the decorated matrix). The
// engine-side decorator + the parity contract are unchanged; unskip when the
// route is re-enabled.
describe.skip("provenance CLI ↔ webapp parity (PWEB-02 / PWEB-03)", () => {
  test("CLI decorated text === webapp /provenance rendered rows (same rows, same degraded resolution)", async () => {
    const rows: ProvenanceMatrixRow[] = storage.provenanceMatrix();
    expect(rows.length).toBeGreaterThan(0);

    // CLI side: resolve+degrade engine-side, then render through the shared
    // decorator. Token unset → every id degrades to {ok:false}.
    const resolved: Map<string, ResolvedShape> = await resolveAndCache(rows, clone);
    const cliText = renderProvenanceDecorated(rows, resolved, "text");
    const cliLinkLines = linkLines(cliText);
    expect(cliLinkLines.length).toBeGreaterThan(0);

    // Webapp side: the page reads the SAME /api/provenance?resolve=1 seam.
    const res = await buildApp().request("/provenance");
    expect(res.status).toBe(200);
    const body = await res.text();

    // Every CLI decorated link line appears in the page body. hono/html escapes
    // `<`/`&`/`"` — the degraded lines contain none of those, so they pass
    // through verbatim and a raw substring check is exact parity.
    for (const line of cliLinkLines) {
      expect(body).toContain(line);
    }

    // The requirement header lines render too (full-matrix parity, not a subset).
    for (const headerLine of cliText.split("\n").filter((l) => !l.startsWith("  "))) {
      expect(body).toContain(headerLine);
    }
  });

  test("degraded parity (PWEB-03): token unset → page shows bare ids + token hint, matching the CLI", async () => {
    const res = await buildApp().request("/provenance");
    const body = await res.text();
    // The opaque issue ids render bare (never resolved on the page).
    expect(body).toContain("ENG-1432");
    expect(body).toContain("ENG-1781");
    // The exact CLI degradation hint appears, identical to `spec provenance
    // --resolve-issues` with no token.
    expect(body).toContain("set SPEC_TRACKER_TOKEN to resolve issue titles");
  });
});
