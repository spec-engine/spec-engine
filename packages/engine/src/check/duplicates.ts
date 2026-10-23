import {
  type Diagnostic,
  DiagnosticCode,
  type DuplicatesConfig,
  type Requirement,
  type Storage,
} from "@spec-engine/shared";
import { readCheckConfig } from "./severity";

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "any",
  "are",
  "as",
  "at",
  "be",
  "by",
  "each",
  "every",
  "for",
  "from",
  "has",
  "have",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "no",
  "not",
  "of",
  "on",
  "one",
  "only",
  "or",
  "shall",
  "that",
  "the",
  "then",
  "this",
  "to",
  "when",
  "where",
  "which",
  "while",
  "with",
]);

/** Lowercased words with punctuation, stopwords, and the EARS keywords removed, first occurrence order. */
function duplicateWords(statement: string): string[] {
  const out = new Set<string>();
  for (const word of statement.toLowerCase().split(/[^\p{L}\p{N}_]+/u)) {
    if (word !== "" && !STOPWORDS.has(word)) out.add(word);
  }
  return [...out];
}

// Folds plural and tense suffixes only; not a Porter stemmer.
const stem = (word: string): string => word.replace(/ies$/, "y").replace(/(ing|ed|es|s)$/, "");

/** The scored token set: each normalized word with its plural or tense suffix stripped. */
export function duplicateTokens(statement: string): Set<string> {
  return new Set(duplicateWords(statement).map(stem));
}

/** Jaccard overlap of two token sets, in [0, 1]. */
export function duplicateScore(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared);
}

export interface DuplicateCandidate {
  id: string;
  statement: string;
}

export interface PossibleDuplicate {
  id: string;
  /** Rounded to two decimals; the threshold compares against this value. */
  score: number;
  statement: string;
}

/** The `possible_duplicates` shape every `--json` surface prints. */
// @spec REQ-071
export function duplicateRefs(dups: readonly PossibleDuplicate[]): { id: string; score: number }[] {
  return dups.map(({ id, score }) => ({ id, score }));
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** The candidates whose score reaches `threshold`, best first, ties by id. */
export function possibleDuplicates(
  statement: string,
  candidates: readonly DuplicateCandidate[],
  threshold: number,
): PossibleDuplicate[] {
  const tokens = duplicateTokens(statement);
  const out: PossibleDuplicate[] = [];
  for (const c of candidates) {
    const score = round2(duplicateScore(tokens, duplicateTokens(c.statement)));
    if (score >= threshold) out.push({ id: c.id, score, statement: c.statement });
  }
  return out.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

const CANDIDATE_LIMIT = 10;

/**
 * The Active non-TERM requirements `spec query` ranks highest for the
 * statement's words, minus `exclude`. `active` maps every Active non-TERM id
 * to its row.
 */
function duplicateCandidates(
  storage: Storage,
  statement: string,
  active: ReadonlyMap<string, Requirement>,
  exclude: ReadonlySet<string>,
): DuplicateCandidate[] {
  const words = duplicateWords(statement);
  if (words.length === 0) return [];
  // Over-fetch so excluded, Draft, and TERM hits do not eat the ten slots.
  const hits = storage.searchFts(words.join(" OR "), CANDIDATE_LIMIT + exclude.size + 20);
  const out: DuplicateCandidate[] = [];
  for (const hit of hits) {
    const row = active.get(hit.req_id);
    if (row === undefined || exclude.has(hit.req_id)) continue;
    out.push({ id: row.id, statement: row.text });
    if (out.length === CANDIDATE_LIMIT) break;
  }
  return out;
}

/** Every Active non-TERM requirement in the index, by id. */
function activeRequirements(storage: Storage): Map<string, Requirement> {
  const out = new Map<string, Requirement>();
  for (const r of storage.listRequirements({ status: "Active" })) {
    if (r.key !== "TERM") out.set(r.id, r);
  }
  return out;
}

export const DEFAULT_DUPLICATE_THRESHOLD = 0.5;

/** The configured threshold, or null when check.json turns duplicate detection off. */
// @spec CHCK-056
// @spec CHCK-057
export function duplicateThreshold(config: DuplicatesConfig | undefined): number | null {
  if (config?.off === true) return null;
  return config?.threshold ?? DEFAULT_DUPLICATE_THRESHOLD;
}

/**
 * The Active requirements an authored statement may duplicate, read from an
 * index that already holds the write. An unreadable check.json yields none:
 * `spec check` owns reporting it.
 * @spec REQ-070
 */
export function scanDuplicates(
  storage: Storage,
  platformDir: string,
  statement: string,
  exclude: readonly string[],
): PossibleDuplicate[] {
  const config = readCheckConfig(platformDir);
  if (!config.ok) return [];
  const threshold = duplicateThreshold(config.config.duplicates);
  if (threshold === null) return [];
  const active = activeRequirements(storage);
  const candidates = duplicateCandidates(storage, statement, active, new Set(exclude));
  return possibleDuplicates(statement, candidates, threshold);
}

const higher = (a: Requirement, b: Requirement): boolean =>
  a.key === b.key ? a.seq > b.seq : a.key > b.key;

/** One warning per unordered pair of Active requirements at or above the threshold, on the higher id. */
// @spec CHCK-055
export function duplicateDiagnostics(storage: Storage, threshold: number): Diagnostic[] {
  const active = activeRequirements(storage);
  const seen = new Set<string>();
  const rows: Diagnostic[] = [];
  for (const req of active.values()) {
    const candidates = duplicateCandidates(storage, req.text, active, new Set([req.id]));
    for (const dup of possibleDuplicates(req.text, candidates, threshold)) {
      const other = active.get(dup.id) as Requirement;
      const [hi, lo] = higher(req, other) ? [req, other] : [other, req];
      const pair = `${hi.id} ${lo.id}`;
      if (seen.has(pair)) continue;
      seen.add(pair);
      rows.push({
        code: DiagnosticCode.POSSIBLE_DUPLICATE,
        severity: "warning",
        repo: null,
        source_file: hi.source_file,
        line: hi.line,
        req_id: hi.id,
        detail: `possible duplicate of ${lo.id} (${dup.score.toFixed(2)})`,
      });
    }
  }
  return rows.sort(
    (a, b) =>
      (a.req_id as string).localeCompare(b.req_id as string) || a.detail.localeCompare(b.detail),
  );
}
