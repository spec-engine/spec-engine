import { expect, test } from "bun:test";
import { SpecConfigSchema } from "./config";

// @spec INDX-027 unit
test("SpecConfigSchema accepts an optional ignore array of non-empty strings", () => {
  expect(
    SpecConfigSchema.safeParse({ specs: "spec-engine@1", ignore: ["generated", "vendor/"] })
      .success,
  ).toBe(true);
  expect(SpecConfigSchema.safeParse({ specs: "spec-engine@1", ignore: [] }).success).toBe(true);
  expect(SpecConfigSchema.safeParse({ specs: "spec-engine@1", ignore: "generated" }).success).toBe(
    false,
  );
  expect(SpecConfigSchema.safeParse({ specs: "spec-engine@1", ignore: [""] }).success).toBe(false);
  expect(SpecConfigSchema.safeParse({ specs: "spec-engine@1", ignore: [42] }).success).toBe(false);
});
