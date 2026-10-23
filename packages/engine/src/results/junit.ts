// @spec PROOF-019
// @spec PROOF-017
//
// Hand-rolled on purpose: no XML dependency. Runner variance (bun's nested
// suites, jest/pytest flat) is absorbed by fixed attribute precedence, not a
// per-runner switch. The `--results` file is untrusted, so the reader is
// XXE-immune by construction:
//   - DOCTYPE, ENTITY, DTD internal subsets, comments, and processing
//     instructions are skipped wholesale; `&xxe;` stays an inert literal.
//   - Only the 5 predefined XML entities decode. No numeric references, no
//     recursive expansion, so billion-laughs cannot happen.
// The caller reads the file; this module does no I/O.

/** One test case extracted from a JUnit XML results file.
 *
 *  `file` is returned VERBATIM (absolute or repo-relative as authored) — path
 *  normalization is the correlator's job, not the reader's.
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
// @spec PROOF-021
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
  return s.replace(/&(amp|lt|gt|quot|apos);/g, (m, name: string) => PREDEFINED_ENTITIES[name] ?? m);
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
    const name = m[1];
    if (name !== undefined) attrs[name] = decodeEntities(m[3] ?? m[4] ?? "");
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
    const c = text[j] ?? "";
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

/** `quote` is the open quote char ("" when unquoted), `depth` the `[ … ]`
 *  internal-subset nesting. */
type DeclScan = { depth: number; quote: string };

/** A quoted `>` (inside a `SYSTEM "…/x>y"` literal) or a `>` still inside a
 *  `[ … ]` internal subset does not end the declaration. */
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

/** A `<![CDATA[` section must never route here: its `]]` collides with the
 *  bracket-depth logic. `skipNonElementMarkup` handles it first. */
function skipDeclaration(text: string, start: number): number {
  const scan: DeclScan = { depth: 0, quote: "" };
  let j = start + 2;
  while (j < text.length) {
    if (stepDeclaration(scan, text[j] ?? "")) return j + 1;
    j++;
  }
  throw new JUnitParseError("unterminated <!…> declaration");
}

type SuiteFrame = { file: string | null; name: string | null };

/** `elementStack` checks tag balance; `suiteStack` holds only testsuites, for
 *  `file` inheritance. `current` is null between testcases (they never nest). */
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

/** An explicit empty `file=""` counts as absent and falls through: returning ""
 *  would never suffix-match, silently dropping the case. */
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
    // Must precede the `<!` branch: `skipDeclaration`'s bracket depth ends
    // early on content like `a]] b > c` or `arr[0] > n`, re-parsing the rest
    // as bogus markup. CDATA only carries failure/output text, so it is
    // skipped to the literal `]]>`.
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
  const tagName = nameMatch[1] ?? "";
  const attrs = parseAttrs(raw.slice(tagName.length));
  if (!selfClosing) state.elementStack.push(tagName);
  onOpen(state, tagName, attrs, selfClosing);
  return next;
}

/**
 * Rows come back in document order, unsorted: the caller owns ordering.
 *
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
