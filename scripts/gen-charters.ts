#!/usr/bin/env bun
// scripts/gen-charters.ts
//
// Regenerates the per-domain charter sections of spec-engine/TAXONOMY.md from
// the `scope` field on each domain envelope.
//
// The charter used to live in two hand-synced homes, and they had drifted in
// 17 of 19 domains. The envelope is the one that ships with every adopter's
// spec and feeds `spec domain list` and `spec req`, so it is canonical and
// this document is derived from it.
//
// Deterministic: domains walked in key order, greedy wrap at a fixed column,
// no clock and no randomness, so two runs are byte-identical.
//
// Usage:
//   bun scripts/gen-charters.ts            rewrite the generated block
//   bun scripts/gen-charters.ts --check    exit 1 if committed != generated

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TAXONOMY = "spec-engine/TAXONOMY.md";
const BEGIN = "<!-- BEGIN GENERATED CHARTERS -->";
const END = "<!-- END GENERATED CHARTERS -->";
const WRAP = 78;

interface Charter {
  key: string;
  scope: string;
  belongs: string;
  excludes: string;
}

/**
 * Greedy wrap to WRAP columns, with `indent` on continuation lines.
 * `prefix` is the label already sitting on the first line (e.g.
 * "- **Belongs here:** "), which eats into that line's budget.
 */
function wrap(text: string, indent: string, prefix = ""): string {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line === "" ? word : `${line} ${word}`;
    const used = lines.length === 0 ? prefix.length : indent.length;
    if (candidate.length > WRAP - used && line !== "") {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line !== "") lines.push(line);
  return lines.map((l, i) => (i === 0 ? l : indent + l)).join("\n");
}

/**
 * Split one envelope `scope` blob into its three parts. The blob is written
 * as "<scope>. Belongs here: <...> Does not belong here: <...>", with any
 * boundary case riding inside the last part.
 */
function parseScope(key: string, scope: string): Charter {
  const belongsAt = scope.indexOf("Belongs here:");
  const excludesAt = scope.indexOf("Does not belong here:");
  if (belongsAt < 0 || excludesAt < 0 || excludesAt < belongsAt) {
    throw new Error(
      `${key}: scope must contain "Belongs here:" then "Does not belong here:" — got ${JSON.stringify(scope.slice(0, 80))}`,
    );
  }
  return {
    key,
    scope: scope.slice(0, belongsAt).trim(),
    belongs: scope.slice(belongsAt + "Belongs here:".length, excludesAt).trim(),
    excludes: scope.slice(excludesAt + "Does not belong here:".length).trim(),
  };
}

/** Every domain's charter, in key order. */
function readCharters(): Charter[] {
  const root = "spec-engine";
  const keys = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  const out: Charter[] = [];
  for (const key of keys) {
    const path = join(root, key, "SPEC.json");
    let doc: { key?: string; scope?: unknown };
    try {
      doc = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      continue;
    }
    if (typeof doc.scope !== "string" || doc.scope.trim() === "") continue;
    out.push(parseScope(doc.key ?? key, doc.scope));
  }
  return out;
}

function render(charters: Charter[]): string {
  const blocks = charters.map(
    (c) =>
      `### ${c.key}\n\n` +
      `**Scope.** ${wrap(c.scope, "", "**Scope.** ")}\n\n` +
      `- **Belongs here:** ${wrap(c.belongs, "  ", "- **Belongs here:** ")}\n` +
      `- **Does not belong here:** ${wrap(c.excludes, "  ", "- **Does not belong here:** ")}\n`,
  );
  return blocks.join("\n");
}

function main(): void {
  const check = process.argv.includes("--check");
  const committed = readFileSync(TAXONOMY, "utf8");
  const beginAt = committed.indexOf(BEGIN);
  const endAt = committed.indexOf(END);
  if (beginAt < 0 || endAt < 0 || endAt < beginAt) {
    console.error(`gen-charters: ${TAXONOMY} is missing the ${BEGIN} / ${END} markers`);
    process.exit(2);
  }

  const generated =
    `${committed.slice(0, beginAt + BEGIN.length)}\n\n` +
    `${render(readCharters())}\n` +
    `${committed.slice(endAt)}`;

  if (!check) {
    writeFileSync(TAXONOMY, generated);
    console.log(`gen-charters: regenerated the charter block in ${TAXONOMY}`);
    return;
  }
  if (generated !== committed) {
    console.error(
      `gen-charters: ${TAXONOMY} drifted from the envelope scope fields (run \`bun scripts/gen-charters.ts\`)`,
    );
    process.exit(1);
  }
  console.log(`gen-charters: ${TAXONOMY} matches the envelope scope fields`);
}

main();
