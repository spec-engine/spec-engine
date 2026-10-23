// "shall" splits the doer from the result; the leading keyword names the
// condition kind. This checks the scaffold only: whether a statement is
// timeless or at the right altitude stays with the human rubric.

export type EarsPattern = "always" | "when" | "while" | "if" | "where";

/** `system` is the doer as written: a leading "the " is not required. */
export interface EarsClauses {
  pattern: EarsPattern;
  condition: string | null;
  system: string;
  response: string;
}

export type EarsResult =
  | { ok: true; clauses: EarsClauses }
  | { ok: false; problem: string; expected: string };

/** Every shape rejection shows a filled-in example, never just a rule name. */
export const EARS_EXPECTED = [
  'When <trigger>, the <system> shall <result> — e.g. "When an unknown id is passed, spec resolve shall print [] and exit 0."',
  "While <state>, the <system> shall <result>",
  "If <failure>, then the <system> shall <result>",
  "Where <feature>, the <system> shall <result>",
  "The <system> shall <result>",
].join("\n  ");

const CONDITIONAL: Array<{ keyword: string; pattern: EarsPattern; re: RegExp }> = [
  { keyword: "When", pattern: "when", re: /^When\s+(.+?),\s*(.+?)\s+shall\s+(.+)$/s },
  { keyword: "While", pattern: "while", re: /^While\s+(.+?),\s*(.+?)\s+shall\s+(.+)$/s },
  { keyword: "If", pattern: "if", re: /^If\s+(.+?),\s*then\s+(.+?)\s+shall\s+(.+)$/s },
  { keyword: "Where", pattern: "where", re: /^Where\s+(.+?),\s*(.+?)\s+shall\s+(.+)$/s },
];

const ALWAYS_RE = /^(.+?)\s+shall\s+(.+)$/s;

const SHAPE_EXPECTED = `Expected one of:\n  ${EARS_EXPECTED}`;

const ONE_PROMISE_EXPECTED =
  "Expected one promise per statement: a second behavior is its own requirement, and the reason goes in the why.";

function reject(problem: string, expected = SHAPE_EXPECTED): EarsResult {
  return { ok: false, problem, expected };
}

const RATIONALE_RE = /\b(because|so that|in order to)\b/i;

/** The one-promise lint over a statement that already has an EARS shape; null when clean.
 *  A trailing ", so <consequence>" is legal: it names an observable result, not a reason.
 *  A second "shall" is the one-promise statement rule's, on every domain. */
// @spec CHCK-060
function onePromiseProblem(statement: string, response: string): string | null {
  if (/;\s/.test(response)) {
    return 'joins a second clause with "; " after "shall" — split it into its own requirement';
  }
  const rationale = statement.match(RATIONALE_RE);
  if (rationale) {
    return `carries a rationale ("${rationale[1]}") — the reason belongs in the why field`;
  }
  return null;
}

function lint(clauses: EarsClauses, statement: string): EarsResult {
  const problem = onePromiseProblem(statement, clauses.response);
  return problem === null ? { ok: true, clauses } : reject(problem, ONE_PROMISE_EXPECTED);
}

export function parseEarsStatement(raw: string): EarsResult {
  const statement = raw.trim();
  if (statement === "") return reject("the statement is empty");

  if (!/\bshall\b/.test(statement)) {
    return reject(
      'missing the word "shall" — it separates who acts from the observable result (e.g. "spec check shall exit 1")',
    );
  }

  for (const { keyword, pattern, re } of CONDITIONAL) {
    if (!statement.startsWith(`${keyword} `)) continue;
    const m = statement.match(re);
    if (m) {
      const [, condition = "", system = "", response = ""] = m;
      return lint(
        {
          pattern,
          condition: condition.trim(),
          system: system.trim().replace(/^the\s+/i, ""),
          response: response.trim(),
        },
        statement,
      );
    }
    if (keyword === "If" && !/,\s*then\s/.test(statement)) {
      return reject(
        'starts with "If" but has no ", then" — the failure clause never hands over to the system',
      );
    }
    return reject(
      `starts with "${keyword}" but the condition clause never ends — add a comma before naming the system that acts`,
    );
  }

  const m = statement.match(ALWAYS_RE);
  if (m) {
    const [, system = "", response = ""] = m;
    if (/,/.test(system)) {
      return reject(
        'the clause before "shall" contains a comma but starts with no condition keyword (When/While/If/Where) — either drop the comma or lead with the condition',
      );
    }
    return lint(
      {
        pattern: "always",
        condition: null,
        system: system.trim().replace(/^the\s+/i, ""),
        response: response.trim(),
      },
      statement,
    );
  }

  return reject('nothing follows "shall" — the observable result is missing');
}
