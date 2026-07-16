// packages/engine/test/gate-classify.test.ts
//
// Plan 06-02 / Task 2 — RED phase: lock the pure-classifier contract for
// `spec gate`. classifyGate is the decision function the CLI command
// (plan 06-03) composes around; everything else (argv parsing, exit
// codes, JSON rendering) is mechanical surface over this outcome.
//
// Tests construct synthetic Requirement / Repo rows literally — no DB,
// no fixture clone, no runIndex, no bun:sqlite. The whole point of the
// pure-classifier seam is that the decision logic can be exhaustively
// covered without I/O.
//
// Coverage map:
//   Test 1 — PASS (GATE-01 happy path)
//   Test 2 — PASS boundary: changed_at_version === pinned_spec_version
//            (Pitfall 5: equality is PASS, NOT VERSION_PIN)
//   Test 3 — NOT_FOUND (GATE-02)
//   Test 4 — DRAFT (GATE-02)
//   Test 5 — SUPERSEDED (GATE-02)
//   Test 6 — SUPERSEDED precedence over VERSION_PIN
//            (Pitfall 3 / T-06-02-02 — the critical branch-order test)
//   Test 7 — VERSION_PIN (GATE-02)
//   Test 8 — null repo throws (defensive contract for plan 06-03)

import { describe, expect, test } from "bun:test";
import type { Repo, Requirement } from "@spec-engine/shared";
import { classifyGate } from "../src/gate/classify";

// --- Synthetic row builders ----------------------------------------------

function makeRepo(pinned_spec_version: number, name = "api"): Repo {
  return {
    name,
    path: `/tmp/${name}`,
    pinned_spec_version,
  };
}

function makeReq(overrides: Partial<Requirement> = {}): Requirement {
  return {
    id: "BILLING-009",
    key: "BILLING",
    seq: 9,
    status: "Active",
    superseded_by: null,
    text: "When a subscription renews, the renewal charge MUST …",
    why: null,
    source_file: "spec-engine/BILLING/SPEC.md",
    line: 1,
    spec_version: 2,
    changed_at_version: 2,
    superseded_at_version: null,
    ...overrides,
  };
}

describe("classifyGate", () => {
  test("Test 1 — PASS: Active req at the member's pin (GATE-01 happy path)", () => {
    const req = makeReq({ status: "Active", changed_at_version: 2 });
    const repo = makeRepo(2);
    const out = classifyGate({
      req,
      repo,
      requestedReqId: "BILLING-009",
      requestedRepoName: "api",
    });
    expect(out.pass).toBe(true);
    expect(out.reason).toBe("PASS");
    expect(out.repo).toBe("api");
    expect(out.req_id).toBe("BILLING-009");
    expect(out.status).toBe("Active");
    expect(out.changed_at_version).toBe(2);
    expect(out.pinned_spec_version).toBe(2);
    expect(out.detail).toContain("Active");
    expect(out.detail).toContain("@2");
  });

  test("Test 2 — PASS boundary: changed_at_version === pinned_spec_version is PASS, NOT VERSION_PIN (Pitfall 5 / T-06-02-01)", () => {
    // Same input as Test 1 — labelled separately because the boundary
    // is the critical Pitfall-5 mitigation: equality must be PASS, and
    // the strict-vs-equal predicate is what makes it so.
    const req = makeReq({ status: "Active", changed_at_version: 2 });
    const repo = makeRepo(2);
    const out = classifyGate({
      req,
      repo,
      requestedReqId: "BILLING-009",
      requestedRepoName: "api",
    });
    expect(out.reason).toBe("PASS");
    expect(out.reason).not.toBe("VERSION_PIN");
    expect(out.pass).toBe(true);
  });

  test("Test 3 — NOT_FOUND: req row is null (GATE-02)", () => {
    const repo = makeRepo(2);
    const out = classifyGate({
      req: null,
      repo,
      requestedReqId: "MISSING-001",
      requestedRepoName: "api",
    });
    expect(out.pass).toBe(false);
    expect(out.reason).toBe("NOT_FOUND");
    expect(out.repo).toBe("api");
    expect(out.req_id).toBe("MISSING-001");
    expect(out.status).toBeNull();
    expect(out.changed_at_version).toBeNull();
    expect(out.pinned_spec_version).toBe(2);
    expect(out.detail.toLowerCase()).toContain("not found");
  });

  test("Test 4 — DRAFT: req status is Draft (GATE-02)", () => {
    const req = makeReq({ status: "Draft", changed_at_version: 2 });
    const repo = makeRepo(2);
    const out = classifyGate({
      req,
      repo,
      requestedReqId: "BILLING-009",
      requestedRepoName: "api",
    });
    expect(out.pass).toBe(false);
    expect(out.reason).toBe("DRAFT");
    expect(out.status).toBe("Draft");
    expect(out.detail).toContain("Draft");
  });

  test("Test 5 — SUPERSEDED: req status is Superseded, detail cites superseded_by id (GATE-02)", () => {
    const req = makeReq({
      id: "BILLING-001",
      seq: 1,
      status: "Superseded",
      changed_at_version: 1,
      superseded_by: "BILLING-009",
    });
    const repo = makeRepo(2);
    const out = classifyGate({
      req,
      repo,
      requestedReqId: "BILLING-001",
      requestedRepoName: "api",
    });
    expect(out.pass).toBe(false);
    expect(out.reason).toBe("SUPERSEDED");
    expect(out.status).toBe("Superseded");
    expect(out.detail).toContain("BILLING-009");
  });

  test("Test 6 — SUPERSEDED precedence over VERSION_PIN (Pitfall 3 / T-06-02-02) — critical branch-order lock", () => {
    // Superseded AND behind-pin: req.changed_at_version=2 > repo.pin=1
    // would naively classify VERSION_PIN. The hard-ordered branches
    // (NOT_FOUND → DRAFT → SUPERSEDED → VERSION_PIN → PASS) MUST surface
    // SUPERSEDED — it's the structural defect, the version skew is a
    // downstream symptom. Maps to ROADMAP Success Criterion #1:
    //   "spec gate mobile BILLING-001 [Superseded] exits non-zero with
    //    reason SUPERSEDED"
    const req = makeReq({
      id: "BILLING-001",
      seq: 1,
      status: "Superseded",
      changed_at_version: 2,
      superseded_by: "BILLING-XYZ",
    });
    const repo = makeRepo(1, "mobile");
    const out = classifyGate({
      req,
      repo,
      requestedReqId: "BILLING-001",
      requestedRepoName: "mobile",
    });
    expect(out.reason).toBe("SUPERSEDED");
    expect(out.reason).not.toBe("VERSION_PIN");
    expect(out.pass).toBe(false);
  });

  test("Test 7 — VERSION_PIN: Active req ahead of member pin (GATE-02), detail cites both versions", () => {
    const req = makeReq({ status: "Active", changed_at_version: 2 });
    const repo = makeRepo(1, "mobile");
    const out = classifyGate({
      req,
      repo,
      requestedReqId: "BILLING-009",
      requestedRepoName: "mobile",
    });
    expect(out.pass).toBe(false);
    expect(out.reason).toBe("VERSION_PIN");
    expect(out.status).toBe("Active");
    expect(out.changed_at_version).toBe(2);
    expect(out.pinned_spec_version).toBe(1);
    expect(out.detail).toContain("@1");
    expect(out.detail).toContain("@2");
  });

  test("Test 8 — null repo throws (defensive contract — caller in plan 06-03 must screen unknown repos to exit 2 BEFORE calling)", () => {
    const req = makeReq();
    expect(() =>
      classifyGate({
        req,
        // biome-ignore lint/suspicious/noExplicitAny: deliberately exercising the defensive null-guard
        repo: null as any,
        requestedReqId: "BILLING-009",
        requestedRepoName: "ghost-repo",
      }),
    ).toThrow(/repo/);
    expect(() =>
      classifyGate({
        req,
        // biome-ignore lint/suspicious/noExplicitAny: deliberately exercising the defensive null-guard
        repo: null as any,
        requestedReqId: "BILLING-009",
        requestedRepoName: "ghost-repo",
      }),
    ).toThrow(/ghost-repo/);
  });
});
