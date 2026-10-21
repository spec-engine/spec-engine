// Hidden citty subcommands the CI smokes invoke against the compiled
// `./dist/spec` binary, so the schema vocabulary is asserted against the
// production artifact.
//
// This file must not import `bun:sqlite`: all DB work routes through
// `../storage/sqlite`, the sole bun:sqlite seam.

import { defineCommand } from "citty";

export const schemaSmokeCommand = defineCommand({
  meta: {
    name: "__schema-smoke",
    description: "(hidden CI) open a fresh DB, exec DDL, assert the schema shape",
    hidden: true,
  },
  args: {
    path: {
      type: "positional",
      required: true,
      description: "tmp sqlite path",
    },
  },
  async run({ args }) {
    const { openStorage, inspectSchema } = await import("../storage/sqlite");
    const s = openStorage(args.path);
    s.close();
    const shape = inspectSchema(args.path);
    const required: {
      tables: string[];
      views: string[];
      virtuals: string[];
      triggers: string[];
    } = {
      tables: [
        "_schema_version",
        "repos",
        "domains",
        "requirements",
        "tags",
        "relations",
        "parse_diagnostics",
      ],
      views: ["coverage"],
      virtuals: ["requirements_fts"],
      triggers: ["requirements_ai", "requirements_ad", "requirements_au"],
    };
    for (const kind of ["tables", "views", "virtuals", "triggers"] as const) {
      for (const n of required[kind]) {
        if (!shape[kind].includes(n)) {
          console.error(`MISSING ${kind}: ${n}`);
          process.exit(1);
        }
      }
    }
    console.log("__schema-smoke OK");
  },
});

export const schemaMismatchSmokeCommand = defineCommand({
  meta: {
    name: "__schema-mismatch-smoke",
    description: "(hidden CI) corrupt _schema_version, re-open, assert silent rebuild",
    hidden: true,
  },
  args: {
    path: {
      type: "positional",
      required: true,
      description: "tmp sqlite path",
    },
  },
  async run({ args }) {
    const { openStorage, poisonSchemaVersion } = await import("../storage/sqlite");
    openStorage(args.path).close();
    poisonSchemaVersion(args.path, 999);
    const s = openStorage(args.path);
    s.close();
    console.log("__schema-mismatch-smoke OK");
  },
});
