// packages/engine/src/results/junit.ts
//
// Dogfood (spec self-consumes this repo — see spec-engine/):
// @spec PROOF-001
//
// GATE-01 (Phase 19): the ONE hand-rolled JUnit XML reader. Turns an untrusted
// `--results` file's bytes into a typed `TestCaseResult[]` — one reader, no
// per-runner adapter zoo (bun-nested vs jest/pytest-flat variance is absorbed
// by fixed attribute-precedence, not a per-runner switch).
//
// Analog: scanner/tags.ts — frozen constant tables at top, ONE pure exported
// `(text) => Row[]` function, a hand-rolled char walker, NO I/O. The caller
// (commands/check.ts, Plan 19-03) reads the file with Bun.file(...).text() and
// passes the text in; this module never touches the filesystem.
//
// SECURITY — XXE-immune by construction (T-19-01 / T-19-02, CLAUDE.md forbids
// native XML deps; RESEARCH § Package Legitimacy flags fast-xml-parser@5 [SUS]):
//   - `<!DOCTYPE ...>`, `<!ENTITY ...>`, DTD internal subsets, comments, and
//     processing instructions are IGNORED wholesale — the scanner never sees,
//     let alone resolves, a user-defined or external entity. `&xxe;` is left as
//     an inert literal token, never expanded to file contents.
//   - ONLY the 5 predefined XML entities decode (`&amp; &lt; &gt; &quot;
//     &apos;`). No numeric character references, no recursive expansion →
//     billion-laughs is structurally impossible.
//   - Malformed / unbalanced XML throws a typed `JUnitParseError` so the
//     upstream check-command catch maps it to exit 2 (crash), distinct from
//     exit 1 (diagnostic) — T-19-03.
//
// D-08 grep-fence: this file imports NO SQLite runtime, no Storage, no DB —
// pure text in, rows out.

/** One test case extracted from a JUnit XML results file.
 *
 *  `file` is returned VERBATIM (absolute or repo-relative as authored) — path
 *  normalization is the correlator's job (Plan 19-02), not the reader's.
 *  `line` is the numeric `testcase@line` when present (bun / pytest emit it),
 *  else null (jest / go-junit-report omit it). `status` collapses the JUnit
 *  child-element vocabulary: a `<failure>` OR `<error>` child → "fail", a
 *  `<skipped>` child (incl. TODO) → "skip", otherwise "pass". */
export type TestCaseResult = {
  file: string;
  name: string;
  line: number | null;
  status: "pass" | "fail" | "skip";
};

/** Thrown on malformed / unbalanced / truncated XML. A typed sentinel (not a
 *  string-matched plain Error) so `commands/check.ts` can branch on it via
 *  `instanceof` and surface exit 2, distinct from an exit-1 diagnostic. */
export class JUnitParseError extends Error {
  constructor(message: string) {
    super(`Malformed JUnit XML: ${message}`);
    this.name = "JUnitParseError";
    // Preserve the prototype chain so `instanceof` survives transpilation.
    Object.setPrototypeOf(this, JUnitParseError.prototype);
  }
}

/** The ONLY entities decoded — the 5 predefined XML entities. Anything else
 *  (including numeric refs and user-defined DOCTYPE entities) is left inert. */
const PREDEFINED_ENTITIES: Readonly<Record<string, string>> = Object.freeze({
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
});

/** Code-file extensions that make a `<testsuite name>` look like a path (so it
 *  can serve as a `file` fallback when no `file` attr is present). */
const PATH_LIKE_EXT = Object.freeze([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rb",
  ".java",
]) as readonly string[];

/** Decode ONLY the 5 predefined XML entities; every other `&…;` token is left
 *  verbatim (XXE / billion-laughs mitigation). */
function decodeEntities(s: string): string {
  return s.replace(
    /&(amp|lt|gt|quot|apos);/g,
    (_m, name: string) => PREDEFINED_ENTITIES[name] as string,
  );
}

/** True if a `<testsuite name>` value looks like a source path (so it can act
 *  as a `file` fallback): contains a `/` or ends in a known code extension. */
function isPathLike(value: string): boolean {
  return value.includes("/") || PATH_LIKE_EXT.some((ext) => value.endsWith(ext));
}

type Attrs = Readonly<Record<string, string>>;

/** Parse `key="value"` / `key='value'` pairs out of a tag body (after the tag
 *  name). Attribute values are entity-decoded. */
function parseAttrs(body: string): Attrs {
  const attrs: Record<string, string> = {};
  const re = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null = re.exec(body);
  while (m !== null) {
    const raw = m[3] !== undefined ? m[3] : (m[4] as string);
    attrs[m[1] as string] = decodeEntities(raw);
    m = re.exec(body);
  }
  return attrs;
}

/** Find the index of the `>` that closes the tag opened at `start` (`<`),
 *  respecting quoted attribute values (an unescaped `>` inside a quoted value
 *  does not end the tag). Returns -1 if the input ends first. */
function findTagEnd(text: string, start: number): number {
  let j = start + 1;
  let quote = "";
  while (j < text.length) {
    const c = text[j] as string;
    if (quote !== "") {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === ">") {
      return j;
    }
    j++;
  }
  return -1;
}

/** Skip a `<! … >` declaration (DOCTYPE, ENTITY, etc.) starting at `start`,
 *  honoring a `[ … ]` internal subset so the whole DTD — including any
 *  `<!ENTITY>` declarations nested inside it — is consumed and ignored.
 *  Quote state is tracked (like `findTagEnd`) so a quoted `>` inside a
 *  `SYSTEM "…/x>y"` literal does not end the skip early. NOTE: CDATA is handled
 *  by its own branch in the main walker BEFORE this is reached — a `<![CDATA[`
 *  section must never route here (its `]]` terminator collides with the
 *  bracket-depth logic; WR-01). Returns the index just past the closing `>`. */
/** Per-character scan state for `skipDeclaration`: `quote` is the open quote
 *  char ("" when unquoted), `depth` the `[ … ]` internal-subset nesting. */
type DeclScan = { depth: number; quote: string };

/** Advance the `<! … >` declaration scanner by one char, mutating quote/bracket
 *  state. Returns true iff `c` is the closing `>` at bracket depth 0 (the
 *  declaration ends here). A quoted `>` (inside a `SYSTEM "…/x>y"` literal) or a
 *  `>` still inside a `[ … ]` internal subset does NOT terminate. */
function stepDeclaration(scan: DeclScan, c: string): boolean {
  if (scan.quote !== "") {
    if (c === scan.quote) scan.quote = "";
    return false;
  }
  if (c === '"' || c === "'") scan.quote = c;
  else if (c === "[") scan.depth++;
  else if (c === "]") scan.depth--;
  else if (c === ">" && scan.depth <= 0) return true;
  return false;
}

function skipDeclaration(text: string, start: number): number {
  const scan: DeclScan = { depth: 0, quote: "" };
  let j = start + 2;
  while (j < text.length) {
    if (stepDeclaration(scan, text[j] as string)) return j + 1;
    j++;
  }
  throw new JUnitParseError("unterminated <!…> declaration");
}

/** A `<testsuite>` frame on the nesting stack — carries the attributes needed
 *  to resolve a descendant testcase's `file` by precedence. */
type SuiteFrame = { file: string | null; name: string | null };

/** Mutable walker state threaded through the module-scope tag handlers (lifted
 *  out of `parseJUnit`'s closures so each stays under the complexity ceiling):
 *   - `results`      — the accumulating flat list of test-case rows.
 *   - `elementStack` — name stack for balance checking (catches unbalanced /
 *                      mismatched tags).
 *   - `suiteStack`   — suite frames for `file` inheritance (subset of
 *                      `elementStack`, testsuites only).
 *   - `current`      — the testcase currently open (null between testcases;
 *                      they never nest). */
type ParserState = {
  results: TestCaseResult[];
  elementStack: string[];
  suiteStack: SuiteFrame[];
  current: { result: TestCaseResult } | null;
};

/** Nearest ancestor `testsuite@file` (searching innermost-first), or "" if none
 *  carries a truthy `file`. An empty `file=""` frame is falsy → skipped. */
function nearestSuiteFile(suiteStack: readonly SuiteFrame[]): string {
  for (let k = suiteStack.length - 1; k >= 0; k--) {
    const f = suiteStack[k]?.file;
    if (f) return f;
  }
  return "";
}

/** Nearest ancestor `testsuite@name` that looks like a path (innermost-first),
 *  or "" if none qualifies. */
function nearestPathLikeSuiteName(suiteStack: readonly SuiteFrame[]): string {
  for (let k = suiteStack.length - 1; k >= 0; k--) {
    const nm = suiteStack[k]?.name;
    if (nm && isPathLike(nm)) return nm;
  }
  return "";
}

/** Resolve a testcase's `file` by fixed precedence (no per-runner branching):
 *   1. `testcase@file`
 *   2. nearest ancestor `testsuite@file`
 *   3. nearest ancestor `testsuite@name` when it looks like a path
 *   4. `testcase@classname`
 *   5. "" (empty) if none of the above resolve
 *
 *  WR-03: an explicit empty `file=""` is treated the same as absent (mirrors
 *  the classname guard below and the truthy suite-file check) so it falls
 *  through to the suite/classname fallbacks instead of returning "" (which
 *  never suffix-matches → a silently dropped case). */
function resolveFile(suiteStack: readonly SuiteFrame[], attrs: Attrs): string {
  if (attrs.file !== undefined && attrs.file !== "") return attrs.file;
  const suiteFile = nearestSuiteFile(suiteStack);
  if (suiteFile !== "") return suiteFile;
  const suiteName = nearestPathLikeSuiteName(suiteStack);
  if (suiteName !== "") return suiteName;
  if (attrs.classname !== undefined && attrs.classname !== "") return attrs.classname;
  return "";
}

/** Open a `<testsuite>`: push a frame for `file` inheritance. A self-closing
 *  `<testsuite/>` holds no testcases, so push+pop is a no-op we simply skip. */
function openTestsuite(state: ParserState, attrs: Attrs, selfClosing: boolean): void {
  const frame: SuiteFrame = {
    file: attrs.file ?? null,
    name: attrs.name ?? null,
  };
  if (!selfClosing) state.suiteStack.push(frame);
}

/** Open a `<testcase>`: build its row (status defaults to "pass"). A
 *  self-closing testcase is pushed immediately; otherwise it becomes `current`
 *  so a child `<failure>`/`<error>`/`<skipped>` can adjust its status. */
function openTestcase(state: ParserState, attrs: Attrs, selfClosing: boolean): void {
  const lineRaw = attrs.line;
  const line = lineRaw !== undefined && /^\d+$/.test(lineRaw) ? Number(lineRaw) : null;
  const result: TestCaseResult = {
    file: resolveFile(state.suiteStack, attrs),
    name: attrs.name ?? "",
    line,
    status: "pass",
  };
  if (selfClosing) {
    state.results.push(result);
  } else {
    state.current = { result };
  }
}

/** A `<failure>` OR `<error>` child → fail (overrides a prior skip). */
function markFail(state: ParserState): void {
  if (state.current !== null) state.current.result.status = "fail";
}

/** A `<skipped>` child (incl. message="TODO") → skip, unless already failed. */
function markSkip(state: ParserState): void {
  if (state.current !== null && state.current.result.status !== "fail") {
    state.current.result.status = "skip";
  }
}

/** Dispatch an open (or self-closing) tag to its status/frame handler. Any tag
 *  outside the JUnit vocabulary is ignored. */
function onOpen(state: ParserState, name: string, attrs: Attrs, selfClosing: boolean): void {
  switch (name) {
    case "testsuite":
      openTestsuite(state, attrs, selfClosing);
      break;
    case "testcase":
      openTestcase(state, attrs, selfClosing);
      break;
    case "failure":
    case "error":
      markFail(state);
      break;
    case "skipped":
      markSkip(state);
      break;
    default:
      break;
  }
}

/** Handle a close tag: push the completed testcase / pop the suite frame. */
function onClose(state: ParserState, name: string): void {
  if (name === "testcase" && state.current !== null) {
    state.results.push(state.current.result);
    state.current = null;
  } else if (name === "testsuite") {
    state.suiteStack.pop();
  }
}

/** If the `<` at `i` opens non-element markup — a comment, processing
 *  instruction, CDATA section, or `<! … >` declaration — consume it and return
 *  the index just past it. Returns -1 when `<` opens a regular element tag (the
 *  caller then parses it via `consumeTag`).
 *
 *  @throws {JUnitParseError} on an unterminated comment / PI / CDATA / declaration. */
function skipNonElementMarkup(text: string, i: number): number {
  if (text.startsWith("<!--", i)) {
    const end = text.indexOf("-->", i + 4);
    if (end === -1) throw new JUnitParseError("unterminated comment");
    return end + 3;
  }
  if (text.startsWith("<?", i)) {
    const end = text.indexOf("?>", i + 2);
    if (end === -1) throw new JUnitParseError("unterminated processing instruction");
    return end + 2;
  }
  if (text.startsWith("<![CDATA[", i)) {
    // WR-01: CDATA content is RAW TEXT with a FIXED, unambiguous `]]>`
    // terminator — it must NOT route through `skipDeclaration` (whose
    // bracket-depth logic terminates early when CDATA content contains `]]`
    // followed later by `>`, e.g. an assertion diff `a]] b > c` or an
    // `arr[0] > n` snippet, which would then re-parse leftover text as bogus
    // markup → spurious JUnitParseError or a corrupted testcase set). CDATA
    // bodies only ever appear inside <failure>/<skipped>/<system-out> text,
    // never as markup the correlator needs, so we scan to the literal `]]>`
    // and ignore the content wholesale.
    const end = text.indexOf("]]>", i + 9);
    if (end === -1) throw new JUnitParseError("unterminated CDATA section");
    return end + 3;
  }
  if (text.startsWith("<!", i)) {
    // DOCTYPE / ENTITY / other declaration — skipped wholesale (XXE-immune).
    return skipDeclaration(text, i);
  }
  return -1;
}

/** Consume one element tag starting at the `<` at `i` — a close tag (balance-
 *  checked + dispatched to `onClose`) or an open / self-closing tag (name +
 *  attrs parsed, dispatched to `onOpen`). Returns the index just past the tag.
 *
 *  @throws {JUnitParseError} on an unterminated / empty / malformed / unbalanced tag. */
function consumeTag(state: ParserState, text: string, i: number): number {
  const gt = findTagEnd(text, i);
  if (gt === -1) throw new JUnitParseError("unterminated tag");
  let raw = text.slice(i + 1, gt).trim();
  const next = gt + 1;
  if (raw === "") throw new JUnitParseError("empty tag");

  if (raw.startsWith("/")) {
    const closeName = raw.slice(1).trim();
    const top = state.elementStack.pop();
    if (top !== closeName) {
      throw new JUnitParseError(`unbalanced tag: </${closeName}> without matching open`);
    }
    onClose(state, closeName);
    return next;
  }

  let selfClosing = false;
  if (raw.endsWith("/")) {
    selfClosing = true;
    raw = raw.slice(0, -1);
  }
  const nameMatch = /^([\w:.-]+)/.exec(raw);
  if (nameMatch === null) throw new JUnitParseError("malformed tag name");
  const tagName = nameMatch[1] as string;
  const attrs = parseAttrs(raw.slice(tagName.length));
  if (!selfClosing) state.elementStack.push(tagName);
  onOpen(state, tagName, attrs, selfClosing);
  return next;
}

/**
 * Parse one JUnit XML document into a flat list of test-case results.
 *
 * Pure: text in, rows out — no I/O, no Storage, no sort (the caller owns any
 * downstream ordering). Recurses nested `<testsuite>` blocks (bun's describe
 * shape) and tolerates the flat jest/pytest shape via fixed attribute
 * precedence (see `resolveFile`). The walker skips non-element markup via
 * `skipNonElementMarkup` (XXE-immune declaration handling) and consumes element
 * tags via `consumeTag`.
 *
 * @param text  Full text of a JUnit XML results file (attacker-influenceable).
 * @throws {JUnitParseError} on malformed / unbalanced / truncated input.
 */
export function parseJUnit(text: string): TestCaseResult[] {
  const state: ParserState = {
    results: [],
    elementStack: [],
    suiteStack: [],
    current: null,
  };

  let i = 0;
  const n = text.length;
  while (i < n) {
    const lt = text.indexOf("<", i);
    if (lt === -1) break; // trailing text — ignored
    i = lt;

    const skipped = skipNonElementMarkup(text, i);
    if (skipped !== -1) {
      i = skipped;
      continue;
    }

    i = consumeTag(state, text, i);
  }

  if (state.elementStack.length > 0) {
    throw new JUnitParseError(`unclosed element(s): ${state.elementStack.join(", ")}`);
  }
  return state.results;
}
