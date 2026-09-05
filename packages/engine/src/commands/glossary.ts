// packages/engine/src/commands/glossary.ts
//
// `spec glossary [platformDir]`: regenerate GLOSSARY.md from the TERM store;
// `--migrate` parses an existing GLOSSARY.md into the store once; `--check`
// exits 1 on drift between the committed file and the generated one. The
// round-trip itself lives in operations/glossary.ts.

import { resolve } from "node:path";
import { defineCommand } from "citty";
import { EXIT } from "../constants";
import { assertSpecPlatform } from "../indexer/discover";
import { checkGlossary, migrateGlossary, writeGlossary } from "../operations/glossary";
import { platformDirArg } from "./_args";
import { exitOnFailure, handleNotAPlatform } from "./_shared";

/** Resolve the optional platformDir positional + run the platform guard. */
function resolvePlatform(platformDirRaw: string | undefined): string {
  const platformDir = resolve(platformDirRaw ?? process.cwd());
  try {
    assertSpecPlatform(platformDir);
  } catch (e) {
    handleNotAPlatform(e);
  }
  return platformDir;
}

async function migrate(platformDir: string, json: boolean): Promise<void> {
  const result = await migrateGlossary(platformDir);
  if (!result.ok) exitOnFailure("spec glossary", result);
  if (result.skipped) {
    console.error(
      `spec glossary: TERM domain already holds ${result.existing} entries — migration skipped`,
    );
    if (json) console.log(JSON.stringify({ migrated: 0, skipped: true }));
    else console.log("migration skipped (TERM domain not empty)");
    return;
  }
  if (json) console.log(JSON.stringify({ migrated: result.migrated, file: result.file }));
  else console.log(`migrated ${result.migrated} terms into ${result.file}`);
}

async function generate(platformDir: string, json: boolean): Promise<void> {
  const result = await writeGlossary(platformDir);
  if (json) console.log(JSON.stringify({ generated: result.generated, file: result.file }));
  else console.log(`generated GLOSSARY.md from ${result.generated} terms`);
}

/** The drift fence: exit 1 on any drift, 0 clean. What `fence_glossary_roundtrip` runs. */
function check(platformDir: string, json: boolean): void {
  if (checkGlossary(platformDir).clean) {
    if (json) console.log(JSON.stringify({ ok: true }));
    else console.error("glossary round-trip: OK (committed GLOSSARY.md == generated)");
    return;
  }
  console.error("glossary drift: committed GLOSSARY.md != generated from the TERM store");
  console.error("run `spec glossary .` to regenerate the human view from the store");
  if (json) console.log(JSON.stringify({ ok: false }));
  process.exit(EXIT.FAILURE);
}

export const glossaryCommand = defineCommand({
  meta: {
    name: "glossary",
    description:
      "Generate GLOSSARY.md from the TERM store (byte-stable); --migrate parses GLOSSARY.md into TERM-001..N; --check fails on drift (committed != generated)",
  },
  args: {
    platformDir: platformDirArg,
    migrate: {
      type: "boolean",
      description: "One-time: parse the committed GLOSSARY.md into TERM-001..N (idempotent-skip)",
    },
    check: {
      type: "boolean",
      description: "Fail (exit 1) if the committed GLOSSARY.md differs from the generated output",
    },
    json: { type: "boolean", description: "Emit a JSON result instead of the text summary" },
  },
  async run({ args }) {
    const platformDir = resolvePlatform(args.platformDir);
    const json = Boolean(args.json);
    if (args.migrate) await migrate(platformDir, json);
    else if (args.check) check(platformDir, json);
    else await generate(platformDir, json);
  },
});
