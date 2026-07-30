// packages/shared/src/ears.ts
//
// The EARS statement grammar — the fixed shape requirement statements are
// written in (mental-model sentence 8: "when X happens, the system shall do
// Y"). Five sentence shapes, each forcing a doer and an observable result:
//
//   Always true          The <system> shall <result>
//   Triggered            When <trigger>, the <system> shall <result>
//   Only in a state      While <state>, the <system> shall <result>
//   Something went wrong If <failure>, then the <system> shall <result>
//   Feature-dependent    Where <feature>, the <system> shall <result>
//
// The word "shall" is the mechanical marker splitting the doer from the
// result; the leading keyword names the condition kind. A statement that fits
// no shape has not decided what triggers the behavior or what observably
// happens — which is the failure this validator exists to catch.
//
// Pure: no I/O, no engine imports, deterministic. LLM-free by design — this
// checks the SCAFFOLD (clauses present, in order); judgment calls (is the
// statement timeless, is the altitude right) stay with the human rubric.

/** Which of the five EARS shapes a statement matched. */
export type EarsPattern = "always" | "when" | "while" | "if" | "where";

/** The statement decomposed into its clauses. `condition` is null for the
 *  always-true shape. `system` is the doer as written (a leading "the " is
 *  not required — "spec resolve shall …" names the system directly). */
export interface EarsClauses {
  pattern: EarsPattern;
  condition: string | null;
  system: string;
  response: string;
}

export type EarsResult =
  | { ok: true; clauses: EarsClauses }
  | { ok: false; problem: string; expected: string };

/** The expected-shapes text every rejection carries — shows a filled-in
 *  example, never just a rule name. */
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

function reject(problem: string): EarsResult {
  return { ok: false, problem, expected: EARS_EXPECTED };
}

/**
 * Parse one requirement statement against the five EARS shapes. Returns the
 * decomposed clauses, or a rejection whose `problem` names what is missing in
 * plain words and whose `expected` lists the shapes with a filled example.
 */
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
      const [, condition, system, response] = m;
      return {
        ok: true,
        clauses: {
          pattern,
          condition: condition.trim(),
          system: system.trim().replace(/^the\s+/i, ""),
          response: response.trim(),
        },
      };
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
    const [, system, response] = m;
    if (/,/.test(system)) {
      return reject(
        'the clause before "shall" contains a comma but starts with no condition keyword (When/While/If/Where) — either drop the comma or lead with the condition',
      );
    }
    return {
      ok: true,
      clauses: {
        pattern: "always",
        condition: null,
        system: system.trim().replace(/^the\s+/i, ""),
        response: response.trim(),
      },
    };
  }

  return reject('nothing follows "shall" — the observable result is missing');
}
