// @spec REQ-031
//
// A candidate counts as a file ref only when, after stripping trailing `.`
// (sentence-final punctuation), it contains at least one `/`. The slash rule
// is what excludes emails (`user@example.com`), version pins
// (`spec-engine@1`), and `@spec` tags. Refs resolve against the platform
// root, not the SPEC.json's directory: the same coordinates as every
// source_file in the derived index.

import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * `(?<![^\s])` means start-of-string or whitespace before the `@`, so emails
 * and version pins, with the `@` glued to preceding text, never match. The
 * slash rule and punctuation strip live in extractRefsFromText, not here.
 */
export const FILE_REF_RE = /(?<![^\s])@([A-Za-z0-9_][A-Za-z0-9_\-./]*)/g;

export function extractRefsFromText(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(FILE_REF_RE)) {
    const candidate = (m[1] ?? "").replace(/\.+$/, "");
    if (candidate.includes("/")) out.push(candidate);
  }
  return out;
}

/**
 * Containment is checked before existence, so a traversal ref landing outside
 * the root is broken even if its target exists.
 */
export function resolveFileRef(platformDir: string, ref: string): boolean {
  const root = resolve(platformDir);
  const abs = resolve(root, ref);
  if (!(abs === root || abs.startsWith(`${root}/`))) return false;
  return existsSync(abs);
}
