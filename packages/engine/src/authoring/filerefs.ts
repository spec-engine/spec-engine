// packages/engine/src/authoring/filerefs.ts
//
// Dogfood (spec self-consumes this repo — see spec-engine/):
// @spec REQ-012
//
// 260605-tqz (D-03): @file-ref substrate — grammar, extraction, and
// platform-root resolution for `@<relative/path>` tokens in requirement
// field text. Consumed by:
//   - commands/req.ts  — authoring-time per-field validation (warn to
//     stderr, never block the save — AUTHC-024)
//
// Q4 (Phase 18): the index-time extraction over raw SPEC.md text (the old
// raw-walk field extractor that fed the index-time broken-file-ref
// diagnostic) is RETIRED with the Markdown parse path. Only the
// authoring-time surface (extractRefsFromText + resolveFileRef) survives — it
// runs against typed field strings, not a Markdown document, so it needs no
// parser regexes.
//
// GRAMMAR (AUTHC-023): a candidate starts at an `@` preceded by
// start-of-string or whitespace, capturing `[A-Za-z0-9_][A-Za-z0-9_\-./]*`.
// A candidate only counts as a file ref when, after stripping trailing `.`
// characters (sentence-final punctuation), the captured path contains at
// least one `/`. The slash rule is what excludes:
//   - emails             (`user@example.com` — `@` preceded by non-space)
//   - version pins       (`spec-engine@1` — same, and no slash)
//   - `@spec` tags       (`@spec` + BILLING-001 — `spec` has no slash)
// Refs resolve relative to the PLATFORM ROOT (not the SPEC.md's dir) —
// the same coordinate system as every platform-relative source_file in the
// derived index.
//
// CONTAINMENT FIRST (T-tqz-01, AUTHC-006 posture): resolveFileRef checks
// that the resolved path stays inside the platform root BEFORE consulting
// the filesystem — a traversal ref (`../escape.ts`) is broken EVEN IF the
// target file exists.
//
// D-08: NO bun:sqlite import — this module is pure substrate
// (node:fs existence checks + node:path resolution + parser regexes only).

import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Global @-ref matcher. `(?<![^\s])` = "not preceded by a non-whitespace
 * char", i.e. start-of-string or whitespace — emails and version pins have
 * the `@` glued to preceding text so they never match. Capture group 1 is
 * the raw path candidate (slash rule + punctuation strip applied by
 * extractRefsFromText, not by the regex).
 */
export const FILE_REF_RE = /(?<![^\s])@([A-Za-z0-9_][A-Za-z0-9_\-./]*)/g;

/**
 * Extract every @-ref from one plain string (authoring-time per-field use).
 * Applies the full grammar: regex match → strip trailing `.` chars →
 * at-least-one-slash rule.
 */
export function extractRefsFromText(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(FILE_REF_RE)) {
    const candidate = (m[1] as string).replace(/\.+$/, "");
    if (candidate.includes("/")) out.push(candidate);
  }
  return out;
}

/**
 * True iff `ref` resolves to an EXISTING file (or directory) INSIDE the
 * platform root. Containment is checked FIRST (T-tqz-01): the resolved
 * absolute path must equal the root or start with `${root}/` — the same
 * startsWith-resolve shape as domain.ts's AUTHC-006 write guard — so a
 * traversal ref landing outside the root is broken even if its target
 * exists.
 */
export function resolveFileRef(platformDir: string, ref: string): boolean {
  const root = resolve(platformDir);
  const abs = resolve(root, ref);
  if (!(abs === root || abs.startsWith(`${root}/`))) return false;
  return existsSync(abs);
}
