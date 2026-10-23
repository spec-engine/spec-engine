import { expect, test } from "bun:test";
import { CheckConfigSchema } from "./checkConfig";
import { SpecConfigSchema } from "./config";
import { renderJsonSchemas, SCHEMA_OUT_DIR } from "./jsonSchema";
import { SCHEMA_URLS } from "./schemaUrl";

// @spec SCHM-045 unit
test("the committed JSON Schema files equal a fresh generation from the zod schemas", async () => {
  const rendered = renderJsonSchemas();
  expect(Object.keys(rendered).sort()).toEqual(["check.json", "member.json", "spec.json"]);
  for (const [file, text] of Object.entries(rendered)) {
    expect(await Bun.file(`${SCHEMA_OUT_DIR}/${file}`).text()).toBe(text);
  }
});

// @spec DIST-025 unit
test("each published schema carries its own versioned URL as $id and a title", () => {
  for (const [name, url] of Object.entries(SCHEMA_URLS)) {
    const doc = JSON.parse(renderJsonSchemas()[`${name}.json`] ?? "{}");
    expect<string>(url).toBe(`https://docs.spec-engine.dev/schema/v1/${name}.json`);
    expect(doc.$id).toBe(url);
    expect(typeof doc.title).toBe("string");
  }
});

// @spec SCHM-046 unit
test("check.json and the member config accept a $schema key and still refuse other unknown keys", () => {
  expect(CheckConfigSchema.safeParse({ $schema: SCHEMA_URLS.check }).success).toBe(true);
  expect(CheckConfigSchema.safeParse({ $schemas: "x" }).success).toBe(false);
  expect(SpecConfigSchema.parse({ $schema: SCHEMA_URLS.member, specs: "spec-engine@1" })).toEqual({
    $schema: SCHEMA_URLS.member,
    specs: "spec-engine@1",
  });
});

// @spec CHCK-071 unit
test("check.json duplicates ignore takes ID/ID pairs and refuses anything else", () => {
  const parse = (ignore: unknown) =>
    CheckConfigSchema.safeParse({ duplicates: { ignore } }).success;
  expect(parse(["REQ-069/REQ-060"])).toBe(true);
  expect(parse(["REQ-069"])).toBe(false);
  expect(parse(["REQ-069/REQ"])).toBe(false);
  expect(parse(["REQ-069/REQ-060/REQ-001"])).toBe(false);
});
