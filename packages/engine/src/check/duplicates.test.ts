import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { DiagnosticCode } from "@spec-engine/shared";
import { coldDuplicateScan, withIndex } from "../operations/_index";
import { check } from "../operations/check";
import { TestPlatform } from "../testing/platform";
import {
  DEFAULT_DUPLICATE_THRESHOLD,
  duplicateScore,
  duplicateThreshold,
  duplicateTokens,
  possibleDuplicates,
} from "./duplicates";

interface GroundTruth {
  groups: string[][];
  keep: string[];
  statements: Record<string, string>;
}

const truth = (await Bun.file(
  join(import.meta.dir, "../testing/fixtures/duplicates/sweep-ground-truth.json"),
).json()) as GroundTruth;

const text = (id: string): string => truth.statements[id] as string;
const score = (a: string, b: string): number =>
  possibleDuplicates(text(a), [{ id: b, statement: text(b) }], 0)[0]?.score ?? 0;

function pairs<T>(xs: readonly T[]): [T, T][] {
  const out: [T, T][] = [];
  for (let i = 0; i < xs.length; i++) {
    for (let j = i + 1; j < xs.length; j++) out.push([xs[i] as T, xs[j] as T]);
  }
  return out;
}

// @spec CHCK-055 unit
describe("duplicate scoring", () => {
  test("drops punctuation, stopwords, the EARS keywords, and plural or tense suffixes", () => {
    expect([...duplicateTokens("When the check runs, the CLI shall report rows.")]).toEqual([
      "check",
      "run",
      "cli",
      "report",
      "row",
    ]);
  });

  test("scores token-set overlap as Jaccard", () => {
    expect(duplicateScore(new Set(["a", "b"]), new Set(["b", "c"]))).toBeCloseTo(1 / 3);
    expect(duplicateScore(new Set(), new Set(["a"]))).toBe(0);
  });

  test("returns only candidates at or above the threshold, best first", () => {
    const found = possibleDuplicates(
      "When a refund is issued, the billing service shall reverse the charge.",
      [
        { id: "B-2", statement: "The auth service shall expire idle sessions." },
        {
          id: "B-1",
          statement:
            "When a refund is issued, the billing service shall reverse the original charge.",
        },
      ],
      DEFAULT_DUPLICATE_THRESHOLD,
    );
    expect(found.map(({ id, score }) => ({ id, score }))).toEqual([{ id: "B-1", score: 0.86 }]);
  });

  test("every merge group the sweep found by wording scores above the threshold", () => {
    const hit = truth.groups
      .filter((group) => pairs(group).some(([a, b]) => score(a, b) >= DEFAULT_DUPLICATE_THRESHOLD))
      .map((group) => group[0]);
    // The other eight groups share a meaning but not their words; token overlap cannot see them.
    expect(hit).toEqual([
      "CHCK-040",
      "CHCK-043",
      "SCHM-016",
      "REQ-027",
      "SCHM-024",
      "PROOF-016",
      "QURY-006",
    ]);
  });

  test("no pair among forty kept requirements scores above the threshold", () => {
    expect(truth.keep).toHaveLength(40);
    const collisions = pairs(truth.keep).filter(
      ([a, b]) => score(a, b) >= DEFAULT_DUPLICATE_THRESHOLD,
    );
    expect(collisions).toEqual([]);
  });
});

// @spec CHCK-056 unit
// @spec CHCK-057 unit
test("check.json duplicates sets the threshold or turns detection off", () => {
  expect(duplicateThreshold(undefined)).toBe(DEFAULT_DUPLICATE_THRESHOLD);
  expect(duplicateThreshold({ threshold: 0.8 })).toBe(0.8);
  expect(duplicateThreshold({ threshold: 0.8, off: true })).toBeNull();
});

describe("against an index", () => {
  let fx: TestPlatform;
  afterEach(() => fx.remove());

  async function platformWithNearDuplicates(): Promise<TestPlatform> {
    fx = TestPlatform.temp("spec-duplicates-");
    const billing = await fx.domain("BILLING");
    await billing.req({
      statement: "When a refund is issued, the billing service shall reverse the original charge.",
    });
    await billing.req({
      statement: "When a session stays idle, the auth service shall expire it.",
    });
    await billing.req({
      statement: "When a refund is issued, the billing service shall reverse the charge.",
    });
    await billing.req({
      statement: "When a refund is issued, the billing service shall reverse the whole charge.",
      status: "draft",
    });
    return fx;
  }

  // @spec CHCK-055 integration
  test("check reports one warning per Active pair, on the higher id", async () => {
    await platformWithNearDuplicates();
    const rows = await withIndex({ platformDir: fx.dir, build: "reset" }, async (h) => {
      const r = await check({ platformDir: fx.dir }, h.storage);
      if (!r.ok) throw new Error(r.detail);
      return r.diagnostics.filter((d) => d.code === DiagnosticCode.POSSIBLE_DUPLICATE);
    });
    expect(rows.map(({ req_id, severity, detail }) => ({ req_id, severity, detail }))).toEqual([
      {
        req_id: "BILLING-003",
        severity: "warning",
        detail: "possible duplicate of BILLING-001 (0.86)",
      },
    ]);
  });

  // @spec CHCK-057 integration
  test("check.json off silences both check and the authoring scan", async () => {
    await platformWithNearDuplicates();
    fx.checkConfig({ severity: [], duplicates: { off: true } });
    const rows = await withIndex({ platformDir: fx.dir, build: "reset" }, async (h) => {
      const r = await check({ platformDir: fx.dir }, h.storage);
      if (!r.ok) throw new Error(r.detail);
      return r.diagnostics.filter((d) => d.code === DiagnosticCode.POSSIBLE_DUPLICATE);
    });
    expect(rows).toEqual([]);
    expect(
      await coldDuplicateScan(fx.dir)(
        "When a refund is issued, the billing service shall reverse the charge.",
        [],
      ),
    ).toEqual([]);
  });

  // @spec REQ-070 integration
  test("the authoring scan names Active matches only, minus the excluded ids", async () => {
    await platformWithNearDuplicates();
    const found = await coldDuplicateScan(fx.dir)(
      "When a refund is issued, the billing service shall reverse the charge.",
      ["BILLING-003"],
    );
    expect(found.map((d) => d.id)).toEqual(["BILLING-001"]);
  });
});
