import { defineCommand } from "citty";
import { KEY_RE, normalizeDomainKey } from "../authoring/domains";
import { EXIT } from "../constants";
import { assertSpecPlatform } from "../indexer/discover";
import type { OpFailure } from "../operations/_result";
import { listDomains, newDomain, setDomainGrammar } from "../operations/domain";
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
    const raw = args.name;
    const platformDir = resolvePlatformDir(args);

    // @spec DOMAIN-029
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
    // @spec REQ-071
    try {
      assertSpecPlatform(platformDir);
    } catch (e) {
      handleNotAPlatform(e);
    }

    // @spec DOMAIN-031
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

const GRAMMARS = ["ears", "freeform"] as const;
const SEVERITIES = ["warning", "error"] as const;

/** The flag value when it is one of `allowed`, undefined when absent; any other word exits 2. */
// @spec DOMAIN-021
function enumFlag<T extends string>(
  flag: string,
  value: string | undefined,
  allowed: readonly T[],
): T | undefined {
  if (value === undefined) return undefined;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  console.error(`spec domain grammar: --${flag} must be one of ${allowed.join(", ")}`);
  process.exit(EXIT.USAGE);
}

export const domainGrammarCommand = defineCommand({
  meta: {
    name: "grammar",
    description: "Set a domain's statement grammar and its severity",
  },
  args: {
    name: {
      type: "positional",
      required: true,
      description: "Domain key (case-insensitive)",
    },
    platformDir: platformDirArg,
    grammar: {
      type: "string",
      description: "ears | freeform",
    },
    severity: {
      type: "string",
      description: "warning | error — how STATEMENT_GRAMMAR and write-time judging treat a miss",
    },
    json: {
      type: "boolean",
      description: "Print { key, grammar, grammar_severity, file }",
    },
  },
  async run({ args }) {
    const platformDir = resolvePlatformDir(args);
    const grammar = enumFlag("grammar", args.grammar, GRAMMARS);
    const grammarSeverity = enumFlag("severity", args.severity, SEVERITIES);
    const result = await setDomainGrammar(platformDir, normalizeDomainKey(args.name), {
      grammar,
      grammarSeverity,
    });
    if (!result.ok) exitOnFailure("spec domain grammar", result);
    // @spec DOMAIN-022
    if (args.json) {
      console.log(
        JSON.stringify({
          key: result.key,
          grammar: result.grammar ?? null,
          grammar_severity: result.grammarSeverity ?? null,
          file: result.file,
        }),
      );
      return;
    }
    console.log(
      `${result.file}: grammar ${result.grammar ?? "freeform"}, severity ${result.grammarSeverity ?? "warning"}`,
    );
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
    grammar: domainGrammarCommand,
  },
});
