import { describe, expect, test } from "bun:test";
import { SPEC_TOKEN } from "../testing/specTag";
import { scanDocFile } from "./docs";

const REPO = "web";
const FILE = "web/docs/guide.md";

// Binding strings are composed from SPEC_TOKEN at runtime: a literal token+id
// pair in this source would be indexed by the code scanner as a dangling tag.
const bind = (id: string) => `<!-- ${SPEC_TOKEN} ${id} -->`;

describe("scanDocFile doc bindings", () => {
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
