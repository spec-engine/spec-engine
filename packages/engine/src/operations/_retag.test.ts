import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TestPlatform } from "../testing/platform";
import { SPEC_TOKEN as T } from "../testing/specTag";
import { coldFreshTags } from "./_index";
import { retagLine } from "./_retag";
import { deprecate } from "./deprecate";
import { supersede } from "./supersede";

describe("retagLine", () => {
  // @spec REQ-065 unit
  test("points the old id at the new one, keeping the level and the line tail", () => {
    expect(retagLine(`it("x"); // ${T} OLD-1 unit trailing`, "OLD-1", "NEW-2", false)).toBe(
      `it("x"); // ${T} NEW-2 unit trailing`,
    );
  });

  test("leaves another id on the same line alone", () => {
    expect(retagLine(`// ${T} KEEP-3 ${T} OLD-1 e2e`, "OLD-1", "NEW-2", false)).toBe(
      `// ${T} KEEP-3 ${T} NEW-2 e2e`,
    );
  });

  test("does not match a longer id that shares the prefix", () => {
    const line = `// ${T} OLD-12`;
    expect(retagLine(line, "OLD-1", "NEW-2", false)).toBe(line);
    expect(retagLine(line, "OLD-1", null, false)).toBe(line);
  });

  test("keeps a carriage return", () => {
    expect(retagLine(`# ${T} OLD-1\r`, "OLD-1", "NEW-2", false)).toBe(`# ${T} NEW-2\r`);
    expect(retagLine(`x = 1 # ${T} OLD-1\r`, "OLD-1", null, false)).toBe("x = 1\r");
  });

  // @spec REQ-067 unit
  test("drops a line that held only the tag, under any comment leader", () => {
    for (const line of [
      `// ${T} OLD-1`,
      `  # ${T} OLD-1 unit`,
      `-- ${T} OLD-1`,
      ` * ${T} OLD-1`,
      `/** ${T} OLD-1 */`,
    ]) {
      expect(retagLine(line, "OLD-1", null, false)).toBeNull();
    }
    expect(retagLine(`<!-- ${T} OLD-1 -->`, "OLD-1", null, true)).toBeNull();
  });

  test("removes only the token and its level when the line holds more", () => {
    expect(retagLine(`foo(); // ${T} OLD-1 unit`, "OLD-1", null, false)).toBe("foo();");
    expect(retagLine(`// ${T} OLD-1 unit ${T} KEEP-3`, "OLD-1", null, false)).toBe(
      `// ${T} KEEP-3`,
    );
    expect(retagLine(`// ${T} KEEP-3 ${T} OLD-1`, "OLD-1", null, false)).toBe(`// ${T} KEEP-3`);
    expect(retagLine(`// note ${T} OLD-1 renewal`, "OLD-1", null, false)).toBe("// note renewal");
    expect(retagLine(`Guides render. <!-- ${T} OLD-1 -->`, "OLD-1", null, true)).toBe(
      "Guides render.",
    );
  });
});

describe("lifecycle commands rewrite tags across a member", () => {
  let fx: TestPlatform;
  const read = (rel: string) => readFileSync(join(fx.dir, rel), "utf8");
  const files = {
    "src/renew.ts": `export const renew = 1; // ${T} BILLING-001\n// ${T} BILLING-002 ${T} BILLING-001\n`,
    "test/renew.test.ts": `// ${T} BILLING-001 unit\nit("x", () => {});\r\n`,
    "deploy.sh": `#!/bin/sh\n# ${T} BILLING-001\necho ok\n`,
    "ci.yml": `jobs: # ${T} BILLING-001 integration\n`,
    "README.md": `Prose. <!-- ${T} BILLING-001 -->\n<!-- ${T} BILLING-001 -->\n`,
    "fixtures/planted.ts": `// ${T} BILLING-001\n`,
    ".cache/x.ts": `// ${T} BILLING-001\n`,
  };

  beforeEach(async () => {
    fx = TestPlatform.temp("spec-retag-").statementRulesOff();
    const billing = await fx.domain("BILLING");
    await billing.req({ statement: "one", why: "w" });
    await billing.req({ statement: "two", why: "w" });
    await fx.member("api", { files });
    mkdirSync(join(fx.dir, ".spec-engine"), { recursive: true });
    writeFileSync(join(fx.dir, ".spec-engine", "note.ts"), `// ${T} BILLING-001\n`);
  });

  afterEach(() => fx.remove());

  // @spec REQ-065 integration
  test("supersede rewrites every site once and a second lookup finds none", async () => {
    const r = await supersede(
      { platformDir: fx.dir, id: "BILLING-001", statement: "one again" },
      coldFreshTags(fx.dir),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.newId).toBe("BILLING-003");
    expect(r.retagged.map((s) => `${s.file}:${s.line}`)).toEqual([
      "api/README.md:1",
      "api/README.md:2",
      "api/ci.yml:1",
      "api/deploy.sh:2",
      "api/src/renew.ts:1",
      "api/src/renew.ts:2",
      "api/test/renew.test.ts:1",
    ]);
    expect(read("api/src/renew.ts")).toBe(
      `export const renew = 1; // ${T} BILLING-003\n// ${T} BILLING-002 ${T} BILLING-003\n`,
    );
    expect(read("api/test/renew.test.ts")).toBe(`// ${T} BILLING-003 unit\nit("x", () => {});\r\n`);
    expect(read("api/deploy.sh")).toBe(`#!/bin/sh\n# ${T} BILLING-003\necho ok\n`);
    expect(read("api/ci.yml")).toBe(`jobs: # ${T} BILLING-003 integration\n`);
    expect(read("api/README.md")).toBe(
      `Prose. <!-- ${T} BILLING-003 -->\n<!-- ${T} BILLING-003 -->\n`,
    );
    expect(read("api/fixtures/planted.ts")).toBe(files["fixtures/planted.ts"]);
    expect(read("api/.cache/x.ts")).toBe(files[".cache/x.ts"]);
    expect(read(".spec-engine/note.ts")).toBe(`// ${T} BILLING-001\n`);
    expect(await coldFreshTags(fx.dir)("BILLING-001")).toEqual([]);
  });

  // @spec REQ-067 integration
  test("deprecate removes whole tag lines and lone tokens, and a second lookup finds none", async () => {
    const r = await deprecate(
      { platformDir: fx.dir, id: "BILLING-001", reason: "gone" },
      coldFreshTags(fx.dir),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.removed).toHaveLength(7);
    expect(read("api/src/renew.ts")).toBe(`export const renew = 1;\n// ${T} BILLING-002\n`);
    expect(read("api/test/renew.test.ts")).toBe(`it("x", () => {});\r\n`);
    expect(read("api/deploy.sh")).toBe("#!/bin/sh\necho ok\n");
    expect(read("api/ci.yml")).toBe("jobs:\n");
    expect(read("api/README.md")).toBe("Prose.\n");
    expect(read("api/fixtures/planted.ts")).toBe(files["fixtures/planted.ts"]);
    expect(await coldFreshTags(fx.dir)("BILLING-001")).toEqual([]);
  });
});
