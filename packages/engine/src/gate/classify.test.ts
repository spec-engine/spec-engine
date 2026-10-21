import { describe, expect, test } from "bun:test";
import type { Repo, Requirement } from "@spec-engine/shared";
import { classifyGate } from "./classify";

function makeRepo(pinned_spec_version: number, name = "api"): Repo {
  return {
    name,
    path: `/tmp/${name}`,
    pinned_spec_version,
    dependency_depth: 0,
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
  test("PASS: an Active req at the member's pin", () => {
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

  test("PASS boundary: changed_at_version === pinned_spec_version is PASS, not VERSION_PIN", () => {
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

  test("NOT_FOUND: req row is null", () => {
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

  test("DRAFT: req status is Draft", () => {
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

  test("SUPERSEDED: req status is Superseded, detail cites superseded_by id", () => {
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

  // @spec GATE-009 unit
  test("DEPRECATED: a deprecated req at or below the pin fails the gate", () => {
    const req = makeReq({
      id: "BILLING-001",
      seq: 1,
      status: "Deprecated",
      changed_at_version: 1,
    });
    const repo = makeRepo(2);
    const out = classifyGate({
      req,
      repo,
      requestedReqId: "BILLING-001",
      requestedRepoName: "api",
    });
    expect(out.pass).toBe(false);
    expect(out.reason).toBe("DEPRECATED");
    expect(out.status).toBe("Deprecated");
    expect(out.detail).toContain("end-of-life");
  });

  test("SUPERSEDED takes precedence over VERSION_PIN for a req also ahead of the pin", () => {
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

  test("VERSION_PIN: Active req ahead of member pin, detail cites both versions", () => {
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

  test("a null repo throws, naming the requested repo", () => {
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
