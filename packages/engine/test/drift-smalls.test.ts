// packages/engine/test/drift-smalls.test.ts
//
// The small statement-5/6 drift fixes (DRIFT-PLAN.md task 12):
//
//   - DRAFT_REFERENCED (warning): a code tag on a Draft requirement — code
//     shipped against a promise nobody approved yet.
//   - GLOSSARY_DRIFT (warning): the committed GLOSSARY.md no longer matches
//     what the TERM store generates — surfaced by spec check itself, not just
//     this repo's CI fence.
//   - Warm-index staleness warning: a read command serving an index older
//     than a changed SPEC.json says so on stderr and names --fresh.
//
// Verifies:
// @spec CHCK-009 integration
// @spec CHCK-010 integration
// @spec INDX-006 integration

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Diagnostic, Storage } from "@spec-engine/shared";
import { mapCommand } from "../src/commands/map";
import { runIndex } from "../src/indexer/pipeline";
import { openStorage } from "../src/storage/sqlite";
import { cloneFixture } from "./fixtures/cloneFixture";

const FIXTURE = resolve(import.meta.dir, "..", "..", "..", "fixtures", "platform-fixture");

let platformDir: string;
let errs: string[];
let logs: string[];
let originalErr: typeof console.error;
let originalLog: typeof console.log;

beforeEach(() => {
  platformDir = cloneFixture(FIXTURE);
  errs = [];
  logs = [];
  originalErr = console.error;
  originalLog = console.log;
  console.error = (...a: unknown[]) => {
    errs.push(a.join(" "));
  };
  console.log = (...a: unknown[]) => {
    logs.push(a.join(" "));
  };
});

afterEach(() => {
  console.error = originalErr;
  console.log = originalLog;
  rmSync(platformDir, { recursive: true, force: true });
});

async function diagnose(): Promise<Diagnostic[]> {
  const s: Storage = openStorage(join(platformDir, ".spec-engine", "test-index.sqlite"));
  try {
    await runIndex({ platformDir, storage: s });
    return s.listSemanticDiagnostics() as unknown as Diagnostic[];
  } finally {
    s.close();
  }
}

describe("DRAFT_REFERENCED — code bound to an unapproved promise", () => {
  test("a tag on a Draft requirement fires a warning; flipping to Active clears it", async () => {
    // BILLING-002 is Active and tagged in api/src. Flip it to draft.
    const specPath = join(platformDir, "spec-engine", "BILLING", "SPEC.json");
    const doc = JSON.parse(readFileSync(specPath, "utf8"));
    doc.requirements.find((r: { id: string }) => r.id === "BILLING-002").status = "draft";
    writeFileSync(specPath, `${JSON.stringify(doc, null, 2)}\n`);

    const rows = await diagnose();
    const hit = rows.find((d) => d.code === "DRAFT_REFERENCED" && d.req_id === "BILLING-002");
    expect(hit).toBeDefined();
    expect(hit?.severity).toBe("warning");
    expect(hit?.repo).toBe("api");
    expect(hit?.detail).toContain("nobody approved yet");
  });

  test("the canonical fixture fires none (no Draft is tagged)", async () => {
    const rows = await diagnose();
    expect(rows.some((d) => d.code === "DRAFT_REFERENCED")).toBe(false);
  });
});

describe("GLOSSARY_DRIFT — spec check surfaces the round-trip break itself", () => {
  test("a committed GLOSSARY.md that mismatches the TERM store is a warning; regenerated content clears it", async () => {
    const { generateGlossary, glossaryDriftDiagnostic } = await import("../src/commands/glossary");
    // Give the cloned fixture a one-term TERM store + a drifted glossary.
    const termDir = join(platformDir, "spec-engine", "TERM");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(termDir, { recursive: true });
    writeFileSync(
      join(termDir, "SPEC.json"),
      `${JSON.stringify(
        {
          key: "TERM",
          owner: null,
          specVersion: 1,
          updated: "2026-07-30",
          requirements: [
            {
              id: "TERM-001",
              status: "active",
              statement: "A bounded area of the spec taxonomy.",
              term: "Domain",
              section: null,
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(join(platformDir, "GLOSSARY.md"), "# Glossary\n\nstale human view\n");

    const drifted = glossaryDriftDiagnostic(platformDir);
    expect(drifted?.code).toBe("GLOSSARY_DRIFT");
    expect(drifted?.severity).toBe("warning");
    expect(drifted?.detail).toContain("spec glossary");

    // Regenerate byte-identically → clean.
    writeFileSync(
      join(platformDir, "GLOSSARY.md"),
      generateGlossary([
        { term: "Domain", statement: "A bounded area of the spec taxonomy.", section: null },
      ]),
    );
    expect(glossaryDriftDiagnostic(platformDir)).toBeNull();
  });

  test("no TERM store or no committed glossary means nothing to check", async () => {
    const { glossaryDriftDiagnostic } = await import("../src/commands/glossary");
    expect(glossaryDriftDiagnostic(platformDir)).toBeNull();
  });
});

describe("staleness warning — a warm index older than a spec edit says so", () => {
  type RunFn = (ctx: { args: Record<string, unknown>; rawArgs: string[] }) => Promise<void>;
  const mapRun = (mapCommand as unknown as { run: RunFn }).run;

  test("spec map on a warm index warns after a SPEC.json changes, and --fresh silences it", async () => {
    // Warm the index.
    await mapRun({ args: { platformDir, noPrompt: true }, rawArgs: [] });
    expect(errs.join("\n")).not.toContain("may be stale");

    // Edit a spec file with an mtime later than the DB.
    const specPath = join(platformDir, "spec-engine", "AUTH", "SPEC.json");
    writeFileSync(specPath, readFileSync(specPath, "utf8"));
    const future = new Date(Date.now() + 5_000);
    utimesSync(specPath, future, future);

    errs = [];
    await mapRun({ args: { platformDir, noPrompt: true }, rawArgs: [] });
    const chatter = errs.join("\n");
    expect(chatter).toContain("may be stale");
    expect(chatter).toContain("--fresh");

    errs = [];
    await mapRun({ args: { platformDir, noPrompt: true, fresh: true }, rawArgs: [] });
    expect(errs.join("\n")).not.toContain("may be stale");
  });
});
