// packages/engine/src/commands/__smoke.ts
//
// Hidden citty subcommands invoked by the CI workflow against the compiled
// `./dist/spec` binary (D-15 / CI-01). These exist solely so the integration
// smoke suite has a deterministic invocation surface and can assert the
// schema vocabulary directly against the production artifact.
//
// IMPORTANT: this file MUST NOT import `bun:sqlite` (D-08). All DB work
// routes through `openStorage` + `inspectSchema` + `poisonSchemaVersion`
// exported from `../storage/sqlite`, which is the sole bun:sqlite seam.

import { defineCommand } from "citty";

export const schemaSmokeCommand = defineCommand({
  meta: {
    name: "__schema-smoke",
    description: "(hidden CI) open a fresh DB, exec DDL, assert the schema shape",
    hidden: true,
    // hidden: true keeps this subcommand out of citty's `--help` output.
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
        "relations", // RED-16 (self-review: the smoke must grow with the DDL)
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
    // Open fresh (or reuse), then poison the version row, then re-open.
    openStorage(args.path).close();
    poisonSchemaVersion(args.path, 999);
    // The next open MUST silently rebuild per D-12; if it throws, we fail.
    const s = openStorage(args.path);
    s.close();
    console.log("__schema-mismatch-smoke OK");
  },
});
