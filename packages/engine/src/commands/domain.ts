// packages/engine/src/commands/domain.ts
//
// `spec domain new <KEY>` scaffolds a domain; `spec domain list` prints the
// keys, or `{ key, scope }` rows under `--json`. The key is normalized and
// grammar-checked here; the scaffold and the listing live in
// operations/domain.ts. Exit codes are 0 and 2 only.

import { defineCommand } from "citty";
import { KEY_RE, normalizeDomainKey } from "../authoring/domains";
import { EXIT } from "../constants";
import { assertSpecPlatform } from "../indexer/discover";
import type { OpFailure } from "../operations/_result";
import { listDomains, newDomain } from "../operations/domain";
import { platformDirArg, resolvePlatformDir } from "./_args";
import { exitOnFailure, handleNotAPlatform } from "./_shared";

/** A refusal to write is printed bare; every other failure carries the command prefix. */
function exitOnNewFailure(failure: OpFailure): never {
  if (failure.reason === "conflict") {
    console.error(failure.detail);
    process.exit(EXIT.USAGE);
  }
  exitOnFailure("spec domain new", failure);
}

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
    platformDir: platformDirArg,
  },
  async run({ args }) {
    const raw = args.name as string;
    const platformDir = resolvePlatformDir(args);

    // @spec DOMAIN-012
    const key = normalizeDomainKey(raw);
    if (key !== raw) {
      console.log(`spec domain: normalized "${raw}" → ${key}`);
    }
    // @spec DOMAIN-013
    if (!KEY_RE.test(key)) {
      console.error("spec domain new: KEY must match /^[A-Z][A-Z0-9]*$/ after normalization");
      process.exit(EXIT.USAGE);
      return;
    }

    const result = await newDomain(platformDir, key);
    if (!result.ok) exitOnNewFailure(result);
    console.log(`created ${result.file}`);
  },
});

export const domainListCommand = defineCommand({
  meta: {
    name: "list",
    description: "List domain keys (sorted, read from the filesystem)",
  },
  args: {
    platformDir: platformDirArg,
    json: {
      type: "boolean",
      description: "Print the domain keys as one sorted JSON array",
    },
  },
  async run({ args }) {
    const platformDir = resolvePlatformDir(args);
    // @spec DOMAIN-018
    try {
      assertSpecPlatform(platformDir);
    } catch (e) {
      handleNotAPlatform(e);
    }

    const { domains } = await listDomains(platformDir);
    // @spec CHRT-011
    if (args.json) {
      console.log(JSON.stringify(domains));
      return;
    }
    for (const { key } of domains) {
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
