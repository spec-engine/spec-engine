// packages/engine/src/commands/domain.ts
//
// Dogfood (spec self-consumes this repo — see spec-engine/):
// @spec DOMAIN-002
// @spec DOMAIN-003
// @spec DOMAIN-010
// @spec DOMAIN-005
// @spec DOMAIN-006
// @spec DOMAIN-008
// @spec DOMAIN-009
//
// `spec domain` — noun-verb surface for managing spec domains
// (spec-engine/<KEY>/).
//
//   spec domain new <name> [platformDir]   — scaffold a fresh SPEC.json
//   spec domain list [platformDir]         — list domain keys
//
// Behaviors (AUTHC IDs):
//   - AUTHC-001/002 — input normalized BEFORE validation (uppercase + strip
//     whitespace, NEVER dashes — parser HEAD_RE reserves `-` as the key/seq
//     separator); normalization message printed only when the input changed.
//   - AUTHC-003 — post-normalization KEY_RE enforcement (V12), exit 2.
//   - AUTHC-004 — scaffold a JSON domain envelope, written through the ONE
//     validateAndWrite seam (VAL-01) — never a bespoke Bun.write of Markdown.
//   - AUTHC-005 — refuse-to-overwrite, exit 2.
//   - AUTHC-006 — resolve() path-containment defense in depth, exit 2.
//   - AUTHC-007/008/009 — list reads the FILESYSTEM (canonical truth), sorted;
//     non-platform dir → formatNotASpecPlatform + exit 2.
//
// Exit codes are 0/2 only (AUTHC-016 — exit 1 reserved for `spec check --ci`).
// D-08: NO bun:sqlite import — no derived-index access, and no
// `.spec-engine/` artifact is ever left behind.

import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { validateAndWrite } from "@spec-engine/shared";
import { defineCommand } from "citty";
import {
  domainsWithScope,
  KEY_RE,
  listDomainKeys,
  normalizeDomainKey,
  scaffoldDomainObject,
} from "../authoring/domains";
import { EXIT } from "../constants";
import { assertSpecPlatform } from "../indexer/discover";
import { handleNotAPlatform } from "./_shared";

export const domainNewCommand = defineCommand({
  meta: {
    name: "new",
    description: "Scaffold a fresh spec-engine/<KEY>/SPEC.json (input normalized)",
  },
  args: {
    name: {
      type: "positional",
      required: true,
      description:
        "Domain name — normalized to uppercase with whitespace stripped, then validated against /^[A-Z][A-Z0-9]*$/",
    },
    platformDir: {
      type: "positional",
      required: false,
      description:
        "Platform directory (default: cwd). SPEC.json is written under <platformDir>/spec-engine/<KEY>/",
    },
  },
  async run({ args }) {
    const raw = args.name as string;
    const platformDir = resolve((args.platformDir as string | undefined) ?? process.cwd());

    // AUTHC-001/002: normalize BEFORE validation; announce only on change.
    const key = normalizeDomainKey(raw);
    if (key !== raw) {
      console.log(`spec domain: normalized "${raw}" → ${key}`);
    }

    // AUTHC-003 (V12 control): post-normalization KEY must match the grammar.
    if (!KEY_RE.test(key)) {
      console.error("spec domain new: KEY must match /^[A-Z][A-Z0-9]*$/ after normalization");
      process.exit(EXIT.USAGE);
      return;
    }

    const dest = join(platformDir, "spec-engine", key, "SPEC.json");

    // AUTHC-006: defense in depth — even though KEY_RE blocks `..` / slashes
    // / dots, confirm the resolved destination stays inside platformDir.
    const resolvedDest = resolve(dest);
    const resolvedRoot = resolve(platformDir);
    if (!(resolvedDest === resolvedRoot || resolvedDest.startsWith(`${resolvedRoot}/`))) {
      console.error(`spec domain new: refusing to write outside platformDir (${resolvedDest})`);
      process.exit(EXIT.USAGE);
      return;
    }

    // AUTHC-005: never clobber an authored spec.
    if (existsSync(dest)) {
      console.error(`refusing to overwrite ${dest}`);
      process.exit(EXIT.USAGE);
      return;
    }

    // WR-03: the prefer-JSON indexer reads SPEC.json ONLY for a domain that
    // owns one, skipping its sibling SPEC.md. Writing a fresh empty
    // (`requirements: []`) SPEC.json beside an existing SPEC.md would make the
    // next `spec index` silently drop every Markdown requirement the domain
    // still holds — canonical-truth data loss with no warning. Make the
    // coexistence rule symmetric: refuse when a sibling SPEC.md exists.
    // (`spec req` migrates a Markdown-only domain forward on write — CR-01.)
    const mdSibling = join(dirname(dest), "SPEC.md");
    if (existsSync(mdSibling)) {
      console.error(
        `refusing to create ${dest}: domain ${key} already exists as spec-engine/${key}/SPEC.md ` +
          "— migrate the SPEC.md first (a fresh empty SPEC.json would shadow it on the next index)",
      );
      process.exit(EXIT.USAGE);
      return;
    }

    // WR-05: compute the local-timezone date, not UTC. toISOString() rolls
    // the date forward at UTC midnight, so a user in America/Los_Angeles
    // running this at 23:30 local on 2026-06-03 would otherwise get
    // 'updated: 2026-06-04' — wrong from the author's perspective and a
    // determinism wart for any future test that snapshots scaffold output.
    const d = new Date();
    const today =
      `${d.getFullYear()}-` +
      `${String(d.getMonth() + 1).padStart(2, "0")}-` +
      `${String(d.getDate()).padStart(2, "0")}`;
    mkdirSync(dirname(dest), { recursive: true });

    // VAL-01: the ONE write seam. validateAndWrite validates the scaffold
    // through the same validateDomainFile the index uses (a dashed/invalid key
    // rejects as INVALID_DOMAIN_FILE, writing NOTHING) and serializes with a
    // fixed key order + single trailing newline — no bespoke Bun.write here.
    const relFile = `spec-engine/${key}/SPEC.json`;
    const res = await validateAndWrite(dest, scaffoldDomainObject(key, today), relFile);
    if (!res.ok) {
      for (const diag of res.diagnostics) {
        console.error(`spec domain new: ${diag.detail}`);
      }
      process.exit(EXIT.USAGE);
      return;
    }
    console.log(`created ${relFile}`);
  },
});

export const domainListCommand = defineCommand({
  meta: {
    name: "list",
    description: "List domain keys (sorted, read from the filesystem)",
  },
  args: {
    platformDir: {
      type: "positional",
      required: false,
      description:
        "Platform directory (default: cwd). Domains are child dirs of <platformDir>/spec-engine/ that contain a SPEC.json (or legacy SPEC.md)",
    },
    json: {
      type: "boolean",
      description: "Print the domain keys as one sorted JSON array",
    },
  },
  async run({ args }) {
    const platformDir = resolve((args.platformDir as string | undefined) ?? process.cwd());

    // AUTHC-009: platform guard FIRST — same command-boundary pattern as
    // map/index/check (friendly message + exit 2, rethrow anything else).
    try {
      assertSpecPlatform(platformDir);
    } catch (e) {
      handleNotAPlatform(e);
    }

    // AUTHC-007/008: filesystem-derived, sorted, one per line; empty → no
    // output, exit 0. NO index open, NO .spec-engine/ artifact, NO cache file.
    // @spec CHRT-004: --json emits a sorted array of `{ key, scope }` objects —
    // scope read per-key from the filesystem (domainsWithScope), null when a
    // domain has no charter, `[]` when there are none (still exit 0). The
    // non-json per-line path is unchanged (keys only).
    if (args.json) {
      console.log(JSON.stringify(await domainsWithScope(platformDir)));
      return;
    }
    for (const key of listDomainKeys(platformDir)) {
      console.log(key);
    }
  },
});

export const domainCommand = defineCommand({
  meta: {
    name: "domain",
    description: "Manage spec domains (spec-engine/<KEY>/)",
  },
  subCommands: {
    new: domainNewCommand,
    list: domainListCommand,
  },
});
