// packages/engine/src/cli.ts
//
// Dogfood (spec self-consumes this repo — see spec-engine/):
// @spec INIT-010
// @spec INIT-011
// @spec INIT-012
// @spec AUTHC-018
//
// citty entrypoint for the compiled `spec` binary (WORK-07 / CI-01).
// `bun build --compile --target=bun-darwin-arm64 packages/engine/src/cli.ts
//  --outfile=dist/spec` reads from this file. Lazy-import every subcommand
// so cold start stays tight under --compile.

import { defineCommand, runMain, showUsage } from "citty";
import packageJson from "../package.json" with { type: "json" };

// Plan 06-03 removed the last `notImplemented` stub (gate). All Phase 1
// subcommand slots are now real implementations; the helper is gone with
// its final caller.

const main = defineCommand({
  meta: {
    name: "spec",
    version: packageJson.version,
    description: "Cross-repo spec engine",
  },
  subCommands: {
    // Future-phase stubs declared up front so `spec --help` documents the
    // full CLI surface from Phase 1 (Open Question Q3 auto-mode resolution).
    index: () => import("./commands/index").then((m) => m.indexCommand),
    init: () => import("./commands/init").then((m) => m.initCommand),
    check: () => import("./commands/check").then((m) => m.checkCommand),
    domain: () => import("./commands/domain").then((m) => m.domainCommand),
    map: () => import("./commands/map").then((m) => m.mapCommand),
    propagation: () => import("./commands/propagation").then((m) => m.propagationCommand),
    query: () => import("./commands/query").then((m) => m.queryCommand),
    relations: () => import("./commands/relations").then((m) => m.relationsCommand),
    provenance: () => import("./commands/provenance").then((m) => m.provenanceCommand),
    req: () => import("./commands/req").then((m) => m.reqCommand),
    term: () => import("./commands/term").then((m) => m.termCommand),
    glossary: () => import("./commands/glossary").then((m) => m.glossaryCommand),
    supersede: () => import("./commands/supersede").then((m) => m.supersedeCommand),
    move: () => import("./commands/move").then((m) => m.moveCommand),
    amend: () => import("./commands/amend").then((m) => m.amendCommand),
    mcp: () => import("./commands/mcp").then((m) => m.mcpCommand),
    resolve: () => import("./commands/resolve").then((m) => m.resolveCommand),
    gate: () => import("./commands/gate").then((m) => m.gateCommand),
    guard: () => import("./commands/guard").then((m) => m.guardCommand),
    // Phase 1's only real subcommand surface: serve --probe (D-14) and
    // the two hidden CI smokes (D-15).
    serve: () => import("./commands/serve").then((m) => m.serveCommand),
    "__schema-smoke": () => import("./commands/__smoke").then((m) => m.schemaSmokeCommand),
    "__schema-mismatch-smoke": () =>
      import("./commands/__smoke").then((m) => m.schemaMismatchSmokeCommand),
  },
  async run({ rawArgs }) {
    // RED-10: bare `spec` prints the full usage block (same renderer as
    // `--help`) and exits 0. The rawArgs guard is mandatory: citty invokes
    // this root run() even AFTER a subcommand dispatch, so an unguarded
    // showUsage would append the help block to every subcommand's output.
    if (rawArgs.length === 0) {
      await showUsage(main);
    }
  },
});

runMain(main);
