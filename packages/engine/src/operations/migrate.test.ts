import { afterEach, beforeEach, expect, test } from "bun:test";
import { cpSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TestPlatform } from "../testing/platform";
import { migrate } from "./migrate";

const PLANTED = join(import.meta.dir, "..", "testing", "fixtures", "legacy-fields", "spec-engine");

let fx: TestPlatform;
const spec = (key: string) => readFileSync(join(fx.dir, "spec-engine", key, "SPEC.json"), "utf8");

beforeEach(() => {
  fx = TestPlatform.temp("spec-migrate-");
  cpSync(PLANTED, join(fx.dir, "spec-engine"), { recursive: true });
});

afterEach(() => fx.remove());

// @spec SCHM-039 unit
test("strips livesIn and verifiedIn from the files that carry them and leaves the rest byte-identical", async () => {
  const clean = spec("CLEAN");
  expect(await migrate(fx.dir)).toEqual({ ok: true, files: ["spec-engine/LEGACY/SPEC.json"] });
  expect(spec("CLEAN")).toBe(clean);
  const legacy = JSON.parse(spec("LEGACY")).requirements[0];
  expect(Object.keys(legacy)).toEqual(["id", "status", "statement", "why", "relates", "issues"]);

  const migrated = spec("LEGACY");
  expect(await migrate(fx.dir)).toEqual({ ok: true, files: [] });
  expect(spec("LEGACY")).toBe(migrated);
});
