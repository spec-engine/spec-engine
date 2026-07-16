// packages/engine/test/scanner-docs.test.ts
//
// RED-15 unit tests for the documentation-binding scanner
// (src/scanner/docs.ts). Markdown is NOT code: only the explicit
// HTML-comment form `<!-- @spec KEY-NNN -->` binds a doc line to a
// requirement (kind `documents`). Prose mentions and code-block examples
// must never mint tags — a README full of `// @spec` examples (this
// repo's own README, for one) would otherwise index as phantom claims.
//
// Mention candidates (requirement-id-shaped tokens on lines WITHOUT a
// binding for that same id) are returned for the pipeline to filter
// against the known-requirement set and route into doctor.md triage.

import { describe, expect, test } from "bun:test";
import { scanDocFile } from "../src/scanner/docs";
import { SPEC_TOKEN } from "./fixtures/specTag";

const REPO = "web";
const FILE = "web/docs/guide.md";

// DOGFOOD: compose every binding string at runtime from SPEC_TOKEN — a
// literal token+id pair in this .ts source would be scooped up by the CODE
// scanner during the repo's self-index and minted as a dangling tag (the
// exact reason test/fixtures/specTag.ts exists).
const bind = (id: string) => `<!-- ${SPEC_TOKEN} ${id} -->`;

describe("scanDocFile (RED-15 doc bindings)", () => {
  test("HTML-comment form binds: one documents-kind tag with file + line", () => {
    const { tags } = scanDocFile(REPO, FILE, `intro\nrenders at build ${bind("DOCS-001")}\n`);
    expect(tags).toEqual([
      {
        req_id: "DOCS-001",
        repo: REPO,
        file: FILE,
        line: 2,
        kind: "documents",
        level: null,
      },
    ]);
  });

  test("code-comment form does NOT bind in markdown (`// @spec` is prose here)", () => {
    const { tags } = scanDocFile(
      REPO,
      FILE,
      `\`\`\`ts\nexport const x = 1; // ${SPEC_TOKEN} DOCS-001\n\`\`\`\n`,
    );
    expect(tags).toEqual([]);
  });

  test("bare prose mention does NOT bind but IS returned as a mention candidate", () => {
    const { tags, mentions } = scanDocFile(REPO, FILE, "See DOCS-003 for the contract.\n");
    expect(tags).toEqual([]);
    expect(mentions).toEqual([
      {
        req_id: "DOCS-003",
        repo: REPO,
        file: FILE,
        line: 1,
        text: "See DOCS-003 for the contract.",
      },
    ]);
  });

  test("a binding line is NOT a mention of the id it binds", () => {
    const { mentions } = scanDocFile(REPO, FILE, `renders ${bind("DOCS-001")}\n`);
    expect(mentions).toEqual([]);
  });

  test("a line binding one id but mentioning another yields a mention for the other only", () => {
    const { tags, mentions } = scanDocFile(
      REPO,
      FILE,
      `Replaces DOCS-002 entirely. ${bind("DOCS-003")}\n`,
    );
    expect(tags.map((t) => t.req_id)).toEqual(["DOCS-003"]);
    expect(mentions.map((m) => m.req_id)).toEqual(["DOCS-002"]);
  });

  test("multiple bindings on one line each produce a tag", () => {
    const { tags } = scanDocFile(REPO, FILE, `both ${bind("DOCS-001")} and ${bind("DOCS-004")}\n`);
    expect(tags.map((t) => t.req_id)).toEqual(["DOCS-001", "DOCS-004"]);
  });

  test("whitespace variants of the comment form bind; malformed ids do not", () => {
    const { tags } = scanDocFile(
      REPO,
      FILE,
      `a <!--${SPEC_TOKEN} DOCS-001-->\nb <!--   ${SPEC_TOKEN}   DOCS-004   -->\nc <!-- ${SPEC_TOKEN} docs-1 -->\n`,
    );
    expect(tags.map((t) => [t.req_id, t.line])).toEqual([
      ["DOCS-001", 1],
      ["DOCS-004", 2],
    ]);
  });
});
