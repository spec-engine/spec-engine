// packages/engine/test/corpus-hygiene.test.ts
//
// Plan 04-02 / STND-02 — the mechanical citation-retargeting regression.
// After the Phase 2 taxonomy reorg the six invariant reqs, their cross-ref
// PROOF-004, and three IN-01 header-comment sites still cited pre-reorg ids
// (or a circular `(Invariant #N)` self-reference). This test locks the
// DECIDED in-scope retargets so a future edit cannot silently reintroduce a
// dead citation.
//
// Grep-assertion pattern mirrored from packages/webapp/test/import-fence.test.ts:
// read each NAMED file, assert a forbidden regex does NOT match, surface the
// offending file/line on failure.
//
// SCOPE (LOCKED — 04-CONTEXT lines 70-72): this test scans ONLY the named
// files. The 63 ordinary code-comment `(Invariant #N)` sites and the deferred
// GOV-02 / GATE-01 / GATE-05 / CR-01 shorthand clusters are P3 work and are
// intentionally NOT asserted here. This file itself carries the forbidden id
// tokens inside its own regexes, so it must NEVER scan itself.

import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const SPEC_ENGINE = join(REPO_ROOT, "spec-engine");
const ENGINE_SRC = join(REPO_ROOT, "packages", "engine", "src");
const ENGINE_TEST = join(REPO_ROOT, "packages", "engine", "test");

const INVARIANT_RE = /\(Invariant #\d/;

/** Read a SPEC.json envelope and return the requirement object for `id`. */
async function readReq(domain: string, id: string) {
  const raw = await Bun.file(join(SPEC_ENGINE, domain, "SPEC.json")).text();
  const env = JSON.parse(raw) as { requirements: Array<{ id: string; why: string }> };
  const req = env.requirements.find((r) => r.id === id);
  if (!req) throw new Error(`corpus-hygiene: ${id} not found in spec-engine/${domain}/SPEC.json`);
  return req;
}

/** Assert a NAMED file does not contain `token`; report file:line on a hit. */
async function assertAbsent(absPath: string, label: string, token: string | RegExp) {
  const src = await Bun.file(absPath).text();
  const lines = src.split("\n");
  const re =
    typeof token === "string" ? new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) : token;
  const hits: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i] ?? "")) hits.push(`  ${label}:${i + 1} — ${(lines[i] ?? "").trim()}`);
  }
  if (hits.length > 0) {
    throw new Error(
      `corpus-hygiene: forbidden token ${String(token)} still present in ${label}:\n${hits.join("\n")}`,
    );
  }
  expect(hits.length).toBe(0);
}

describe("corpus hygiene (STND-02 — citation retargeting)", () => {
  test("the 6 self-referential active whys carry no (Invariant #N) parenthetical", async () => {
    const selfRefs: Array<[string, string]> = [
      ["INDX", "INDX-001"],
      ["INDX", "INDX-002"],
      ["SCHM", "SCHM-001"],
      ["SCHM", "SCHM-002"],
      ["CHCK", "CHCK-002"],
      ["PROP", "PROP-002"],
    ];
    for (const [domain, id] of selfRefs) {
      const req = await readReq(domain, id);
      expect(req.why, `${id}.why must not cite (Invariant #N)`).not.toMatch(INVARIANT_RE);
    }
  });

  test("PROOF-004's cross-ref why cites CHCK-002, not an Invariant number", async () => {
    const req = await readReq("PROOF", "PROOF-004");
    expect(req.why).not.toMatch(INVARIANT_RE);
    expect(req.why).toContain("CHCK-002");
  });

  test("check/removed.ts header comment names no GOV-01", async () => {
    await assertAbsent(join(ENGINE_SRC, "check", "removed.ts"), "check/removed.ts", "GOV-01");
  });

  test("check/propagation-teeth.ts header comments name no PROP-01 or GATE-02", async () => {
    const abs = join(ENGINE_SRC, "check", "propagation-teeth.ts");
    await assertAbsent(abs, "check/propagation-teeth.ts", "PROP-01");
    await assertAbsent(abs, "check/propagation-teeth.ts", "GATE-02");
  });

  test("commands/check.ts cites no GOV-01, PROP-01, or dissolved GOV-03", async () => {
    const abs = join(ENGINE_SRC, "commands", "check.ts");
    await assertAbsent(abs, "commands/check.ts", "GOV-01");
    await assertAbsent(abs, "commands/check.ts", "PROP-01");
    await assertAbsent(abs, "commands/check.ts", "GOV-03");
  });

  test("check-ci.test.ts cites no non-existent Invariant #7", async () => {
    await assertAbsent(join(ENGINE_TEST, "check-ci.test.ts"), "check-ci.test.ts", "Invariant #7");
  });
});

// Plan 04-03 / STND-03 — the AUTHC-017 eviction regression. The import-count
// rule was reclassified as a dev convention (AGENTS.md + the D-08 CI fence),
// not a spec-engine requirement. This locks the eviction: the id is gone from
// the envelope, no binding @spec tag survives, its comment citations are
// reworded to D-08, and the only surviving AUTHC-017 token is the audited
// `@spec approve` guard tombstone. Matcher note: /@spec\s+AUTHC-017/ is
// BINDING-specific — it does NOT match the `@spec approve AUTHC-017` form
// (whitespace after @spec is followed by "approve", not the id).
describe("corpus hygiene (STND-03 — AUTHC-017 eviction)", () => {
  const AUTHC_SPEC = join(SPEC_ENGINE, "AUTHC", "SPEC.json");
  const DOMAINS_TS = join(ENGINE_SRC, "authoring", "domains.ts");
  const BINDING_TAG_RE = /@spec\s+AUTHC-017/;

  test("AUTHC-017 is absent from the AUTHC envelope", async () => {
    const env = JSON.parse(await Bun.file(AUTHC_SPEC).text()) as {
      requirements: Array<{ id: string }>;
    };
    expect(env.requirements.some((r) => r.id === "AUTHC-017")).toBe(false);
  });

  test("the reworded citation sites carry no AUTHC-017 token", async () => {
    const sites: Array<[string, string]> = [
      [join(ENGINE_TEST, "cli-domain.test.ts"), "cli-domain.test.ts"],
      [join(ENGINE_SRC, "authoring", "filerefs.ts"), "authoring/filerefs.ts"],
      [join(ENGINE_SRC, "commands", "domain.ts"), "commands/domain.ts"],
      [join(ENGINE_SRC, "commands", "req.ts"), "commands/req.ts"],
    ];
    for (const [abs, label] of sites) {
      await assertAbsent(abs, label, "AUTHC-017");
    }
  });

  test("authoring/domains.ts carries no binding AUTHC-017 @spec tag, only the approve tombstone", async () => {
    await assertAbsent(DOMAINS_TS, "authoring/domains.ts", BINDING_TAG_RE);
    const src = await Bun.file(DOMAINS_TS).text();
    expect(src).toContain("@spec approve AUTHC-017");
  });
});
