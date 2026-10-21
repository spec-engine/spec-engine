// @spec GUARD-023
// @spec GUARD-015
// @spec GUARD-016
// @spec GUARD-017
// @spec GUARD-018
// @spec GUARD-020
// @spec GUARD-021
// @spec GUARD-022

import { describe, expect, test } from "bun:test";
import type { SpecRequirement } from "@spec-engine/shared";
import { renderGuard, sortLosses } from "./format";
import { classifyLosses, type GuardFacts, type Loss } from "./losses";

function req(id: string, status: string, extra: Partial<SpecRequirement> = {}): SpecRequirement {
  return {
    id,
    status,
    statement: `${id} statement`,
    relates: [],
    livesIn: [],
    issues: [],
    aliases: [],
    cites: [],
    ...extra,
  };
}

function facts(over: Partial<GuardFacts> = {}): GuardFacts {
  return {
    baseReqs: [],
    baseReqPath: new Map(),
    baseImplSite: new Map(),
    baseVerifySite: new Map(),
    worktreeReqIds: new Set(),
    worktreeActiveIds: new Set(),
    worktreeSupersedesTargets: new Set(),
    worktreeImplCount: new Map(),
    worktreeVerifyCount: new Map(),
    deletedSpecFiles: [],
    ...over,
  };
}

describe("classifyLosses — loss taxonomy", () => {
  test("REQUIREMENT_REMOVED: Active base req absent from worktree, not superseded", () => {
    const losses = classifyLosses(
      facts({
        baseReqs: [req("BILLING-001", "active")],
        baseReqPath: new Map([["BILLING-001", "spec-engine/BILLING/SPEC.json"]]),
        // absent from worktree
      }),
    );
    expect(losses).toHaveLength(1);
    expect(losses[0]?.kind).toBe("REQUIREMENT_REMOVED");
    expect(losses[0]?.req_id).toBe("BILLING-001");
    expect(losses[0]?.file).toBe("spec-engine/BILLING/SPEC.json");
  });

  test("IMPL_LOST: last implementing tag removed for a surviving Active req", () => {
    const losses = classifyLosses(
      facts({
        baseReqs: [req("BILLING-001", "active")],
        baseImplSite: new Map([["BILLING-001", { file: "src/billing.ts", line: 12 }]]),
        worktreeReqIds: new Set(["BILLING-001"]),
        worktreeActiveIds: new Set(["BILLING-001"]),
        // worktreeImplCount has 0 for BILLING-001 → last impl gone
      }),
    );
    expect(losses).toHaveLength(1);
    expect(losses[0]?.kind).toBe("IMPL_LOST");
    expect(losses[0]?.file).toBe("src/billing.ts");
    expect(losses[0]?.line).toBe(12);
  });

  test("IMPL_LOST does NOT fire when another impl tag survives", () => {
    const losses = classifyLosses(
      facts({
        baseReqs: [req("BILLING-001", "active")],
        baseImplSite: new Map([["BILLING-001", { file: "src/billing.ts", line: 12 }]]),
        worktreeReqIds: new Set(["BILLING-001"]),
        worktreeActiveIds: new Set(["BILLING-001"]),
        worktreeImplCount: new Map([["BILLING-001", 1]]), // survives elsewhere
      }),
    );
    expect(losses).toHaveLength(0);
  });

  test("VERIFY_LOST: last verifying tag removed for a surviving Active req", () => {
    const losses = classifyLosses(
      facts({
        baseReqs: [req("BILLING-001", "active")],
        baseVerifySite: new Map([["BILLING-001", { file: "test/billing.test.ts", line: 4 }]]),
        worktreeReqIds: new Set(["BILLING-001"]),
        worktreeActiveIds: new Set(["BILLING-001"]),
      }),
    );
    expect(losses).toHaveLength(1);
    expect(losses[0]?.kind).toBe("VERIFY_LOST");
  });

  test("SPEC_FILE_DELETED: a canonical spec file is gone", () => {
    const losses = classifyLosses(facts({ deletedSpecFiles: ["spec-engine/LEGAL/SPEC.json"] }));
    expect(losses).toHaveLength(1);
    expect(losses[0]?.kind).toBe("SPEC_FILE_DELETED");
    expect(losses[0]?.req_id).toBeNull();
    expect(losses[0]?.file).toBe("spec-engine/LEGAL/SPEC.json");
  });

  // @spec GUARD-011 unit
  test("deleting a non-Active entry (Draft/Superseded) is a REQUIREMENT_REMOVED — history is never deleted", () => {
    const losses = classifyLosses(
      facts({ baseReqs: [req("BILLING-009", "draft"), req("BILLING-008", "superseded")] }),
    );
    expect(losses).toHaveLength(2);
    expect(losses.every((l) => l.kind === "REQUIREMENT_REMOVED")).toBe(true);
    const superseded = losses.find((l) => l.req_id === "BILLING-008");
    expect(superseded?.detail).toContain("never deleted");
  });

  test("the supersede exemption does NOT excuse deleting an already-superseded entry", () => {
    const losses = classifyLosses(
      facts({
        baseReqs: [req("BILLING-008", "superseded", { supersededBy: "BILLING-009" })],
        worktreeReqIds: new Set(["BILLING-009"]),
        worktreeActiveIds: new Set(["BILLING-009"]),
      }),
    );
    expect(losses).toHaveLength(1);
    expect(losses[0]?.kind).toBe("REQUIREMENT_REMOVED");
    expect(losses[0]?.req_id).toBe("BILLING-008");
  });

  test("removing a superseded entry is a loss", () => {
    const losses = classifyLosses(facts({ baseReqs: [req("BILLING-008", "superseded")] }));
    expect(losses).toHaveLength(1);
    expect(losses[0]?.kind).toBe("REQUIREMENT_REMOVED");
  });
});

describe("classifyLosses — suppressions", () => {
  test("forward supersede suppresses REQUIREMENT_REMOVED (base points at surviving successor)", () => {
    const losses = classifyLosses(
      facts({
        baseReqs: [req("BILLING-002", "active", { supersededBy: "BILLING-003" })],
        worktreeReqIds: new Set(["BILLING-003"]),
        worktreeActiveIds: new Set(["BILLING-003"]),
      }),
    );
    expect(losses).toHaveLength(0);
  });

  test("backward supersede suppresses REQUIREMENT_REMOVED (surviving req supersedes the base id)", () => {
    const losses = classifyLosses(
      facts({
        baseReqs: [req("BILLING-002", "active")],
        worktreeReqIds: new Set(["BILLING-003"]),
        worktreeActiveIds: new Set(["BILLING-003"]),
        worktreeSupersedesTargets: new Set(["BILLING-002"]),
      }),
    );
    expect(losses).toHaveLength(0);
  });

  test("a status flip to superseded suppresses IMPL_LOST/VERIFY_LOST (retag worklist)", () => {
    const losses = classifyLosses(
      facts({
        baseReqs: [req("BILLING-002", "active")],
        baseImplSite: new Map([["BILLING-002", { file: "src/billing.ts", line: 3 }]]),
        worktreeReqIds: new Set(["BILLING-002"]), // survives...
        worktreeActiveIds: new Set(), // ...but no longer Active
      }),
    );
    expect(losses).toHaveLength(0);
  });

  test("deprecating in the same change suppresses tag losses", () => {
    const losses = classifyLosses(
      facts({
        baseReqs: [req("BILLING-001", "active")],
        baseImplSite: new Map([["BILLING-001", { file: "src/billing.ts", line: 12 }]]),
        worktreeReqIds: new Set(["BILLING-001"]),
        worktreeActiveIds: new Set(), // deprecated now — not Active
      }),
    );
    expect(losses).toHaveLength(0);
  });
});

describe("renderGuard — product surface + byte-stable JSON", () => {
  const implVerify: Loss[] = [
    {
      kind: "IMPL_LOST",
      req_id: "BILLING-009",
      file: "src/billing.ts",
      line: 12,
      detail: "x",
    },
    { kind: "VERIFY_LOST", req_id: "BILLING-009", file: "test/b.test.ts", line: 4, detail: "y" },
  ];

  test("aggregated impl+test block matches the fixed product copy exactly", () => {
    const text = renderGuard(implVerify, "text", "HEAD");
    expect(text).toBe(
      "🛑 spec-guard: BILLING-009 is Active and this change deletes its only implementation " +
        "(src/billing.ts:12) and its verifying test. Requirements are superseded, never deleted. " +
        "Either run `spec supersede BILLING-009` with a successor, or run " +
        "`spec deprecate BILLING-009 " +
        '--reason "..."` to end it with a recorded reason.',
    );
  });

  test("REQUIREMENT_REMOVED renders the requirement-itself clause", () => {
    const text = renderGuard(
      [
        {
          kind: "REQUIREMENT_REMOVED",
          req_id: "BILLING-001",
          file: "s.json",
          line: 0,
          detail: "d",
        },
      ],
      "text",
      "HEAD",
    );
    expect(text).toContain("BILLING-001 is Active and this change deletes the requirement itself.");
  });

  test("SPEC_FILE_DELETED renders a file-level block", () => {
    const text = renderGuard(
      [
        {
          kind: "SPEC_FILE_DELETED",
          req_id: null,
          file: "spec-engine/LEGAL/SPEC.json",
          line: 0,
          detail: "d",
        },
      ],
      "text",
      "HEAD",
    );
    expect(text).toContain("the canonical spec file spec-engine/LEGAL/SPEC.json was deleted");
  });

  test("clean tree → [] in JSON, ✓ line in text", () => {
    expect(renderGuard([], "json", "HEAD")).toBe("[]");
    expect(renderGuard([], "text", "main")).toContain(
      "no requirements about to be lost against main",
    );
  });

  test("JSON is deterministically sorted and byte-stable regardless of input order", () => {
    const a = renderGuard([implVerify[1] as Loss, implVerify[0] as Loss], "json", "HEAD");
    const b = renderGuard([implVerify[0] as Loss, implVerify[1] as Loss], "json", "HEAD");
    expect(a).toBe(b);
    const rows = JSON.parse(a) as Loss[];
    expect(rows.map((r) => r.kind)).toEqual(["IMPL_LOST", "VERIFY_LOST"]);
  });

  test("sortLosses orders by (req_id, kind, file, line) and never mutates input", () => {
    const input: Loss[] = [
      { kind: "VERIFY_LOST", req_id: "B-2", file: "z", line: 1, detail: "" },
      { kind: "IMPL_LOST", req_id: "B-1", file: "a", line: 2, detail: "" },
    ];
    const snapshot = [...input];
    const sorted = sortLosses(input);
    expect(sorted.map((l) => l.req_id)).toEqual(["B-1", "B-2"]);
    expect(input).toEqual(snapshot);
  });
});
