// packages/engine/src/testing/platform.test.ts
//
// The platform builder every test authors its fixture through. It writes each
// SPEC.json by calling the operations, so the file on disk is what a user's
// `spec` command would have produced; it serializes no envelope of its own,
// and it refuses to write a spec file by hand.
//
// Verifies:
// @spec SCHM-026 unit

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validateDomainFile } from "@spec-engine/shared";
import { entryOf, plantEdit } from "./plant";
import { TestPlatform } from "./platform";

let fx: TestPlatform;

beforeEach(() => {
  fx = TestPlatform.temp("spec-builder-");
});

afterEach(() => {
  fx.remove();
});

describe("TestPlatform authors every spec file through the operations", () => {
  test("a domain carries its options and a requirement carries status, relates, and cites", async () => {
    const billing = await fx.domain("BILLING", {
      scope: "money in, money out",
      owner: "drea",
      grammar: "ears",
      grammarSeverity: "error",
    });
    const first = await billing.req();
    const draft = await billing.req({
      status: "draft",
      relates: [first.id],
      cites: [{ term: "TERM-001", pinned: 1 }],
      issue: "ENG-1",
    });
    expect([first.id, draft.id]).toEqual(["BILLING-001", "BILLING-002"]);

    const doc = await billing.read();
    expect(doc.scope).toBe("money in, money out");
    expect(doc.owner).toBe("drea");
    expect(doc.grammar).toBe("ears");
    expect(doc.grammarSeverity).toBe("error");
    expect(doc.specVersion).toBeUndefined();
    const entry = entryOf(doc, draft.id);
    expect(entry.status).toBe("draft");
    expect(entry.relates).toEqual([first.id]);
    expect(entry.cites).toEqual([{ term: "TERM-001", pinned: 1 }]);
    expect(entry.issues).toEqual([{ role: "created", id: "ENG-1" }]);
    // The bytes on disk are the seam's: schema-valid, one trailing newline.
    const raw = await billing.raw();
    expect(raw.endsWith("}\n")).toBe(true);
    expect(validateDomainFile(JSON.parse(raw), billing.relFile).ok).toBe(true);
  });

  test("a grammar refusal surfaces as a thrown setup error, and nothing is written", async () => {
    const strict = await fx.domain("STRICT", { grammar: "ears", grammarSeverity: "error" });
    const before = await strict.raw();
    await expect(strict.req({ statement: "Sessions should be secure." })).rejects.toThrow(
      /refused \(usage\)/,
    );
    expect(await strict.raw()).toBe(before);
  });

  test("supersede, deprecate, amend, and move produce the lifecycle states", async () => {
    const billing = await fx.domain("BILLING");
    const auth = await fx.domain("AUTH");
    const [a, b, c] = await billing.reqs(3);
    const { oldId, newId } = await billing.supersede(a, { statement: "The system shall renew." });
    await billing.deprecate(b, "no longer sold");
    await billing.amend(c, { why: "because" });
    const moved = await billing.moveTo(newId, "AUTH");

    const doc = await billing.read();
    expect(entryOf(doc, oldId).status).toBe("superseded");
    expect(entryOf(doc, oldId).supersededBy).toBe(newId);
    expect(entryOf(doc, newId).status).toBe("superseded");
    expect(entryOf(doc, newId).supersededBy).toBe(moved.newId);
    expect(entryOf(doc, b).status).toBe("deprecated");
    expect(entryOf(doc, b).deprecatedReason).toBe("no longer sold");
    expect(entryOf(doc, c).why).toBe("because");
    expect(entryOf(await auth.read(), moved.newId).statement).toBe("The system shall renew.");
  });

  test("the TERM store scaffolds with its version and terms revise and confirm", async () => {
    const terms = await fx.terms();
    const billing = await fx.domain("BILLING");
    const term = await fx.term({ term: "Drift", definition: "a pin behind", aliases: ["lag"] });
    const citing = await billing.req({ cites: [{ term: term.id, pinned: 1 }] });
    const revised = await fx.reviseTerm(term.id, "a pin behind the current version");
    expect(revised.specVersion).toBe(2);
    const confirmed = await fx.confirmTerm(citing.id, term.id);
    expect(confirmed.pinned).toBe(2);
    expect((await terms.read()).specVersion).toBe(2);
    expect(entryOf(await terms.read(), term.id).aliases).toEqual(["lag"]);
  });

  test("a member carries its pin, ignore list, members glob, and files", async () => {
    const api = await fx.member("api", {
      pin: "spec-engine@3",
      ignore: ["generated"],
      members: "packages/*",
      files: { "src/renew.ts": "export const renew = 1;\n" },
    });
    const config = JSON.parse(readFileSync(join(api.dir, "spec-engine.member.json"), "utf8"));
    expect(config).toEqual({
      specs: "spec-engine@3",
      ignore: ["generated"],
      members: "packages/*",
    });
    expect(existsSync(join(api.dir, "src", "renew.ts"))).toBe(true);
    const plain = await fx.member("web");
    expect(JSON.parse(readFileSync(join(plain.dir, "spec-engine.member.json"), "utf8"))).toEqual({
      specs: "spec-engine@1",
    });
  });

  test("file() refuses to write a SPEC.json by hand", async () => {
    expect(() => fx.file("spec-engine/X/SPEC.json", "{}")).toThrow(/by hand/);
    expect(existsSync(fx.specFile("X"))).toBe(false);
    const api = await fx.member("api");
    expect(() => api.file("SPEC.json", "{}")).toThrow(/by hand/);
  });
});

describe("plantEdit writes a planted state through the seam", () => {
  test("a schema-valid edit lands; a schema-invalid edit throws and writes nothing", async () => {
    const billing = await fx.domain("BILLING");
    const [a] = await billing.reqs(2);
    await plantEdit(fx.dir, "BILLING", (doc) => {
      entryOf(doc, a).status = "retired";
      doc.requirements = doc.requirements.filter((r) => r.id === a);
    });
    const doc = await billing.read();
    expect(doc.requirements.map((r) => r.id)).toEqual([a]);
    expect(entryOf(doc, a).status).toBe("retired");

    const before = await billing.raw();
    await expect(
      plantEdit(fx.dir, "BILLING", (d) => {
        entryOf(d, a).statement = "";
      }),
    ).rejects.toThrow(/invalid after the edit/);
    expect(await billing.raw()).toBe(before);
  });
});
