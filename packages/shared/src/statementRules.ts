// The mechanical half of rule 0: a pattern catches only what it can catch
// exactly, and the judgment half stays with the author.

export const RULE_ZERO =
  "A requirement is one rule of the product's behavior, stated from the user's point of view.";

export const STATEMENT_RULES = [
  "one-sentence",
  "length",
  "no-file-path",
  "no-test-narration",
  "no-toolchain-layout",
  "no-history",
  "no-jargon",
  "no-tool-statement",
  "one-promise",
  "no-mechanism",
  "no-contrast",
  "no-document-content",
  "where-takes-a-feature",
  "no-trailing-commentary",
] as const;

export type StatementRule = (typeof STATEMENT_RULES)[number];
export type RuleSeverity = "error" | "warning" | "off";

export interface StatementRulesConfig {
  maxLength?: number | undefined;
  jargon?: string[] | undefined;
  exemptNames?: string[] | undefined;
  severity?: Partial<Record<StatementRule, RuleSeverity>> | undefined;
}

export interface StatementFinding {
  rule: StatementRule;
  detail: string;
  reason: string;
}

export const DEFAULT_MAX_STATEMENT_LENGTH = 280;

export const DEFAULT_JARGON: readonly string[] = [
  "seam",
  "seams",
  "rung",
  "rungs",
  "residue",
  "matrix entry",
  "stage runner",
  "the stage",
  "self-member",
  "context walk",
  "canonical row",
  "layer",
  "corpus",
];

/** A rule absent here grades `error` when check.json names no severity for it. */
export const DEFAULT_RULE_SEVERITY: Partial<Record<StatementRule, RuleSeverity>> = {
  "no-trailing-commentary": "warning",
};

// @spec CHRT-031
export function ruleSeverity(
  rule: StatementRule,
  config: StatementRulesConfig | undefined,
): RuleSeverity {
  return config?.severity?.[rule] ?? DEFAULT_RULE_SEVERITY[rule] ?? "error";
}

export const STATEMENT_RULE_REASONS: Record<StatementRule, string> = {
  "one-sentence": "a statement is one testable sentence",
  length: "a sentence a reader holds at once",
  "no-file-path": "which file holds what is layout, not behaviour",
  "no-test-narration": "how a test is written is not what the product does",
  "no-toolchain-layout": "how CI and tooling are arranged is not a product behaviour",
  "no-history": "a statement says what holds now, not how it got there",
  "no-jargon": "a reader without the codebase cannot parse project jargon",
  "no-tool-statement": "naming the tool in use is a decision record, not a requirement",
  "one-promise": "a second promise is its own requirement",
  "no-mechanism": "how the product does it is design, not behaviour",
  "no-contrast": "a behaviour is stated by what it does, not by what it is not",
  "no-document-content": "what a document contains is documentation, not behaviour",
  "where-takes-a-feature": "a flag or an invocation is a trigger and takes When",
  "no-trailing-commentary": "a trailing so-clause names one short consequence, not a second point",
};

const EXT = "ts|tsx|js|mjs|json|yml|yaml|sql|md|toml|css|astro|sh";

const FILE_PATH: readonly RegExp[] = [
  /(?<![\w/@-])(?:apps|packages|tooling|modules|spec-engine|\.github)\/[\w.@/-]*/i,
  // Backticked only: bare a/b/c is prose. A leading `@` is a package, `/` a
  // route, `<` or `://` a URL, and one slash with no dot is a job name.
  /`(?![@/<])(?![^`\s]*:\/\/)(?![^`\s./]*\/[^`\s./]*`)[^`\s]*\/[^`\s]*`/,
  new RegExp(
    `\\b(?!(?:next|node|postgres)\\.js\\b|auth\\.md\\b)[\\w-]+(?:\\.[\\w-]+)*\\.(?:${EXT})\\b`,
    "i",
  ),
];

const FIXED_RULES: readonly { rule: StatementRule; patterns: readonly RegExp[] }[] = [
  {
    rule: "no-test-narration",
    patterns: [
      /\b(?:describe|it|test)\(/,
      /\.(?:test|spec)\./i,
      /\btest files?\b/i,
      /\bthe tests?\b/i,
      /\bvitest\b/i,
      /\bplaywright\b/i,
      /\bfixtures?\b(?! (?:accounts?|seed))/i,
      /\bplanted\b/i,
    ],
  },
  {
    rule: "no-toolchain-layout",
    patterns: [
      /\bworkflows?\b/i,
      /\b(?:test|full|CI|job|build|RLS|per-table) matrix\b|\bmatrix (?:entry|entries|job)\b/i,
      /\brunners?\b/i,
      /\bGitHub Actions\b/i,
      /\bci\.yml\b/i,
      /(?<!`)\bpnpm\s/i,
      /\bturbo\b/i,
      /\bbiome\b/i,
      /\bdrizzle-kit\b/i,
      /\btsx\s/i,
      /\bbun\s/i,
      /\bShellCheck\b/i,
      /\bcoverage thresholds?\b/i,
      /`(?:pnpm )?ci:/i,
      /@spec(?![\w-])/i,
      /\btag(?:ged)? in\b/i,
    ],
  },
  {
    rule: "no-history",
    patterns: [
      /\bamended\b/i,
      /\bsupersed\w*(?: by)? `?[A-Z][A-Z0-9]*-\d/,
      /\breplaced by\b|\breplace[sd] `?(?:ADR-|[A-Z][A-Z0-9]*-\d)/i,
      /\bpreviously\b/i,
      /\bformerly\b/i,
      /\bused to\b/i,
      /\bsince `?\d/i,
      /\bmigration \d/i,
      /\b0\d{3}_/,
      /\bPORT-T/,
      /\bADR-/,
    ],
  },
];

const TOOL_STATEMENT: readonly RegExp[] = [
  /\bwe use\b/i,
  /\bis used for\b/i,
  /\bis the tool\b/i,
  /\bis pinned (?:to|at) (?:`?[\w@./-]+`? )?v?\d/i,
];

const MECHANISM: readonly RegExp[] = [
  /\bvia\b/i,
  /\bby (?:means of|\w+ing)\b/i,
  /\bthrough the\b/i,
  /\busing\b/i,
];

const CONTRAST: readonly RegExp[] = [/\binstead of\b/i, /\brather than\b/i, /\bnever\b.*?\bbut\b/i];

/** A word that opens a noun or prepositional phrase: `, and <word>` continues a list. A word
 *  ending in a single `s` is a plural noun, since a verb after `shall` takes its bare form. */
const NOT_A_VERB =
  /^(?:the|a|an|its|their|each|every|all|any|no|one|two|both|then|so|not|only|that|this|these|those|it|they|as|by|of|on|in|at|to|for|from|with|without|under|over|into|onto|if|when|where|while|whether|\w*[^s]s)$/i;

function afterShall(statement: string): string | null {
  const m = /\bshall\b/i.exec(statement);
  return m ? statement.slice(m.index + m[0].length) : null;
}

/** The doer: the text before the first `shall`, from the last comma before it. */
function subjectOf(statement: string): string {
  const m = /\bshall\b/i.exec(statement);
  const head = m ? statement.slice(0, m.index) : statement;
  return head.slice(head.lastIndexOf(",") + 1);
}

function onePromiseDetail(statement: string): string | null {
  const tail = afterShall(statement);
  if (tail === null) return null;
  if (/\bshall\b/i.test(tail)) return 'a second "shall"';
  const exit = tail.match(/, and exits? \d+/i);
  if (exit) return `"${exit[0]}"`;
  // A serial list ("A, B, and C") carries a comma before its `, and`.
  const chained = tail.match(/^[^,]*(, and ([a-z]+)\b)/);
  if (chained?.[1] && chained[2] && !NOT_A_VERB.test(chained[2])) return `"${chained[1]}"`;
  return null;
}

function contrastDetail(statement: string): string | null {
  const fixed = hitsDetail(statement, CONTRAST);
  if (fixed !== null) return fixed;
  const tail = afterShall(statement) ?? "";
  return hitsDetail(tail, [/\bnot\b[^,.]*, (?!and\b|or\b|then\b)\w+/i, /, not\b/i]);
}

function documentContentDetail(statement: string): string | null {
  const anywhere = hitsDetail(statement, [/\bREADME\b/, /\bthe document states\b/i]);
  if (anywhere !== null) return anywhere;
  const subject = hitsDetail(subjectOf(statement), [
    /\bthe table\b/i,
    /\bsection\b/i,
    /\bdocument\b/i,
    /\bthe agent reference\b/i,
    /\bAGENTS\.md\b/,
    /\bTAXONOMY\.md\b/,
  ]);
  return subject === null ? null : `${subject} as the subject`;
}

function whereFeatureDetail(statement: string): string | null {
  const m = /^Where\s+([^,]*),/.exec(statement.trim());
  if (!m?.[1]) return null;
  return hitsDetail(m[1], [
    /(?<![\w-])--[\w-]+/,
    /\b(?:runs?|is run|is given|are given|is passed|are passed)\b/i,
  ]);
}

const MAX_SO_CLAUSE_WORDS = 8;

function trailingCommentaryDetail(statement: string): string | null {
  const m = /, so (?!that\b)(.*)$/is.exec(statement);
  if (!m?.[1]) return null;
  const clause = m[1].replace(/[.?!]$/, "").trim();
  const words = clause.split(/\s+/).length;
  if (words > MAX_SO_CLAUSE_WORDS)
    return `a ${words}-word so-clause; at most ${MAX_SO_CLAUSE_WORDS}`;
  const second = clause.match(/,|\b(?:and|which|while|because)\b/i);
  return second ? `a so-clause with a second verb phrase ("${second[0]}")` : null;
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function jargonPatterns(words: readonly string[]): RegExp[] {
  if (words.length === 0) return [];
  return [new RegExp(`\\b(?:${words.map(escapeRegExp).join("|")})\\b`, "i")];
}

/** The statement with every exempt name replaced; a name ending in `/` exempts the whole path under it. */
function withoutExemptNames(statement: string, names: readonly string[]): string {
  let out = statement;
  for (const name of names) {
    const tail = name.endsWith("/") ? "[^\\s`]*" : "(?![\\w-])";
    out = out.replace(new RegExp(`(?<![\\w.-])${escapeRegExp(name)}${tail}`, "g"), "X");
  }
  return out;
}

const QUOTED = /`[^`]*`|"[^"]*"|“[^”]*”/g;
const NON_TERMINAL = /\b(?:e\.g|i\.e|etc|vs|cf)\.|\d+(?:\.\d+)+/gi;
const TERMINAL = /[.?!](?=\s|$)/g;

function sentenceDetail(statement: string): string | null {
  if (/[\r\n]/.test(statement)) return "contains a line break";
  const prose = statement.replace(QUOTED, "Q").replace(NON_TERMINAL, "N");
  const terminals = prose.match(TERMINAL)?.length ?? 0;
  if (terminals === 1 && /[.?!]$/.test(prose.trimEnd())) return null;
  return `${terminals} sentence terminators; exactly one, at the end`;
}

function hitsDetail(text: string, patterns: readonly RegExp[]): string | null {
  const hits = patterns
    .map((pattern) => text.match(pattern)?.[0])
    .filter((hit): hit is string => hit !== undefined);
  return hits.length > 0 ? hits.map((hit) => `"${hit}"`).join(", ") : null;
}

/** The enabled rules a statement breaks, in rule order; empty when it passes. */
// @spec CHRT-014
// @spec CHRT-015
// @spec CHRT-016
// @spec CHRT-017
// @spec CHRT-018
// @spec CHRT-019
// @spec CHRT-020
// @spec CHRT-021
// @spec CHRT-025
// @spec CHRT-026
// @spec CHRT-027
// @spec CHRT-028
// @spec CHRT-029
// @spec CHRT-030
// @spec CHCK-048
export function statementFindings(
  statement: string,
  config: StatementRulesConfig = {},
): StatementFinding[] {
  const maxLength = config.maxLength ?? DEFAULT_MAX_STATEMENT_LENGTH;
  const details: Record<StatementRule, string | null> = {
    "one-sentence": sentenceDetail(statement),
    length:
      statement.length > maxLength ? `${statement.length} characters; at most ${maxLength}` : null,
    "no-file-path": hitsDetail(withoutExemptNames(statement, config.exemptNames ?? []), FILE_PATH),
    "no-test-narration": null,
    "no-toolchain-layout": null,
    "no-history": null,
    "no-jargon": hitsDetail(statement, jargonPatterns(config.jargon ?? DEFAULT_JARGON)),
    "no-tool-statement": hitsDetail(statement, TOOL_STATEMENT),
    "one-promise": onePromiseDetail(statement),
    "no-mechanism": hitsDetail(afterShall(statement) ?? "", MECHANISM),
    "no-contrast": contrastDetail(statement),
    "no-document-content": documentContentDetail(statement),
    "where-takes-a-feature": whereFeatureDetail(statement),
    "no-trailing-commentary": trailingCommentaryDetail(statement),
  };
  for (const { rule, patterns } of FIXED_RULES) details[rule] = hitsDetail(statement, patterns);
  const findings: StatementFinding[] = [];
  for (const rule of STATEMENT_RULES) {
    const detail = details[rule];
    if (detail !== null && config.severity?.[rule] !== "off") {
      findings.push({ rule, detail, reason: STATEMENT_RULE_REASONS[rule] });
    }
  }
  return findings;
}

/** `<rule>: <detail> — <reason>`, the one line every surface prints for a finding. */
export function formatStatementFinding(f: StatementFinding): string {
  return `${f.rule}: ${f.detail} — ${f.reason}`;
}
