import { describe, expect, test } from "bun:test";
import { DDL, SCHEMA_VERSION } from "@spec-engine/shared";

describe("schema FTS tokenizer", () => {
  test("SCHEMA_VERSION reflects the latest schema change (11: repos.dependency_depth, the member's position in the platform map's dependsOn graph)", () => {
    // Bump this expectation with every deliberate schema change: it makes the
    // committer acknowledge that every on-disk index rebuilds on upgrade.
    expect(SCHEMA_VERSION).toBe(11);
  });

  test("FTS_DDL uses porter unicode61 tokenizer and preserves external-content mode", () => {
    expect(DDL).toContain("tokenize='porter unicode61'");
    // Contentless mode would return NULL for text/why on query results.
    expect(DDL).toContain("content='requirements'");
  });
});
