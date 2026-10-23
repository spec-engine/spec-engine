import { afterEach, beforeEach, expect, test } from "bun:test";
import { cpSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TestPlatform } from "../testing/platform";
import { migrate, migrationPendingDiagnostics } from "./migrate";

const PLANTED = join(import.meta.dir, "..", "testing", "fixtures", "legacy-fields", "spec-engine");

let fx: TestPlatform;
const spec = (key: string) => readFileSync(join(fx.dir, "spec-engine", key, "SPEC.json"), "utf8");

beforeEach(() => {
  fx = TestPlatform.temp("spec-migrate-");
  cpSync(PLANTED, join(fx.dir, "spec-engine"), { recursive: true });
});

afterEach(() => fx.remove());

const SPEC_URL = "https://docs.spec-engine.dev/schema/v1/spec.json";

// @spec SCHM-039 unit
test("strips livesIn and verifiedIn from the files that carry them and a second run writes nothing", async () => {
  expect(await migrate(fx.dir)).toEqual({
    ok: true,
    files: ["spec-engine/CLEAN/SPEC.json", "spec-engine/LEGACY/SPEC.json"],
  });
  const legacy = JSON.parse(spec("LEGACY")).requirements[0];
  expect(Object.keys(legacy)).toEqual(["id", "status", "statement", "why", "relates", "issues"]);

  const migrated = spec("LEGACY");
  expect(await migrate(fx.dir)).toEqual({ ok: true, files: [] });
  expect(spec("LEGACY")).toBe(migrated);
});

// @spec SCHM-048 unit
test("adds the $schema key as the first key of every SPEC.json, check.json, and member config that lacks one", async () => {
  const cleanBefore = JSON.parse(spec("CLEAN"));
  const checkJson = fx.file("spec-engine/check.json", '{ "severity": [] }\n');
  const emptyCheck = "{}\n";
  const member = await fx.member("api");
  const pin = member.file("spec-engine.member.json", '{\n  "specs": "spec-engine@1"\n}\n');

  expect(await migrate(fx.dir)).toEqual({
    ok: true,
    files: [
      "spec-engine/CLEAN/SPEC.json",
      "spec-engine/LEGACY/SPEC.json",
      "spec-engine/check.json",
      "api/spec-engine.member.json",
    ],
  });
  expect(JSON.parse(spec("CLEAN"))).toEqual({ $schema: SPEC_URL, ...cleanBefore });
  expect(Object.keys(JSON.parse(spec("LEGACY")))[0]).toBe("$schema");
  expect(readFileSync(checkJson, "utf8")).toBe(
    '{\n  "$schema": "https://docs.spec-engine.dev/schema/v1/check.json", "severity": [] }\n',
  );
  expect(readFileSync(pin, "utf8")).toBe(
    '{\n  "$schema": "https://docs.spec-engine.dev/schema/v1/member.json",\n  "specs": "spec-engine@1"\n}\n',
  );

  fx.file("spec-engine/check.json", emptyCheck);
  await migrate(fx.dir);
  expect(JSON.parse(readFileSync(checkJson, "utf8"))).toEqual({
    $schema: "https://docs.spec-engine.dev/schema/v1/check.json",
  });
});

// @spec SCHM-047 unit
test("a $schema key that is not first stays where it is through a migrate rewrite", async () => {
  const member = await fx.member("api");
  const body = '{\n  "specs": "spec-engine@1",\n  "$schema": "./local.json"\n}\n';
  const pin = member.file("spec-engine.member.json", body);
  await migrate(fx.dir);
  expect(readFileSync(pin, "utf8")).toBe(body);
});

// @spec CHCK-054 unit
// @spec CHCK-063 unit
test("each file carrying a retired key or lacking $schema gets one MIGRATION_PENDING warning naming which, until spec migrate runs", async () => {
  const row = (source_file: string, detail: string) => ({
    code: "MIGRATION_PENDING" as const,
    severity: "warning" as const,
    repo: null,
    source_file,
    line: null,
    req_id: null,
    detail,
  });
  expect(await migrationPendingDiagnostics(fx.dir)).toEqual([
    row(
      "spec-engine/CLEAN/SPEC.json",
      `spec-engine/CLEAN/SPEC.json has no $schema key; run spec migrate to add ${SPEC_URL}`,
    ),
    row(
      "spec-engine/LEGACY/SPEC.json",
      `spec-engine/LEGACY/SPEC.json still carries the retired livesIn or verifiedIn fields and has no $schema key; run spec migrate to strip them and add ${SPEC_URL}`,
    ),
  ]);
  await migrate(fx.dir);
  expect(await migrationPendingDiagnostics(fx.dir)).toEqual([]);
});
