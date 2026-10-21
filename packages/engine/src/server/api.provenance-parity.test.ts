// Composing mountApi + mountWebapp on one app is a test-only engine import;
// production webapp source stays hermetic.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ProvenanceMatrixRow, Storage } from "@spec-engine/shared";
import { mountWebapp } from "@spec-engine/webapp/server";
import { Hono } from "hono";
import { runIndex } from "../indexer/pipeline";
import { type ResolvedShape, renderProvenanceDecorated } from "../provenance/format";
import { resolveAndCache } from "../provenance/resolve";
import { openStorage } from "../storage/sqlite";
import { cloneFixture } from "../testing/cloneFixture";
import { mountApi } from "./api";

const FIXTURE = resolve(import.meta.dir, "..", "..", "..", "..", "fixtures", "platform-fixture");

let clone: string;
let storage: Storage;

let priorFlags: string | undefined;

beforeAll(async () => {
  // The provenance read API is feature-flagged; this suite tests the ON
  // behavior (the OFF 404 is locked in feature-flags.test.ts).
  priorFlags = process.env.SPEC_FLAGS;
  process.env.SPEC_FLAGS = "provenance";
  clone = cloneFixture(FIXTURE);
  rmSync(join(clone, ".spec-engine"), { recursive: true, force: true });
  storage = openStorage(join(clone, ".spec-engine", "index.sqlite"));
  await runIndex({ platformDir: clone, storage });
});

afterAll(() => {
  if (priorFlags === undefined) delete process.env.SPEC_FLAGS;
  else process.env.SPEC_FLAGS = priorFlags;
  storage.close();
  rmSync(clone, { recursive: true, force: true });
});

function buildApp(): Hono {
  const app = new Hono();
  mountApi(app, storage, clone);
  mountWebapp(app);
  return app;
}

/** The link lines carry the decorated overlay or degradation that proves parity. */
function linkLines(decoratedText: string): string[] {
  return decoratedText.split("\n").filter((l) => l.startsWith("  "));
}

// PARKED while the webapp /provenance route is flag-gated off
// (PROVENANCE_ENABLED=false in packages/webapp/src/pages/provenance.ts → the
// page renders a coming-soon placeholder, not the decorated matrix). The
// engine-side decorator + the parity contract are unchanged; unskip when the
// route is re-enabled.
describe.skip("provenance CLI ↔ webapp parity", () => {
  test("CLI decorated text === webapp /provenance rendered rows (same rows, same degraded resolution)", async () => {
    const rows: ProvenanceMatrixRow[] = storage.provenanceMatrix();
    expect(rows.length).toBeGreaterThan(0);

    const resolved: Map<string, ResolvedShape> = await resolveAndCache(rows, clone);
    const cliText = renderProvenanceDecorated(rows, resolved, "text");
    const cliLinkLines = linkLines(cliText);
    expect(cliLinkLines.length).toBeGreaterThan(0);

    const res = await buildApp().request("/provenance");
    expect(res.status).toBe(200);
    const body = await res.text();

    // hono/html escapes `<`/`&`/`"`; the degraded lines contain none of those,
    // so a raw substring check is exact parity.
    for (const line of cliLinkLines) {
      expect(body).toContain(line);
    }

    for (const headerLine of cliText.split("\n").filter((l) => !l.startsWith("  "))) {
      expect(body).toContain(headerLine);
    }
  });

  test("degraded parity: token unset → page shows bare ids + token hint, matching the CLI", async () => {
    const res = await buildApp().request("/provenance");
    const body = await res.text();
    expect(body).toContain("ENG-1432");
    expect(body).toContain("ENG-1781");
    expect(body).toContain("set SPEC_TRACKER_TOKEN to resolve issue titles");
  });
});
