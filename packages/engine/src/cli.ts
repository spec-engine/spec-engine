// @spec INIT-054
// @spec REQ-019
// Every subcommand is lazy-imported so the compiled binary starts fast.

import { defineCommand, runMain, showUsage } from "citty";
import packageJson from "../package.json" with { type: "json" };
import { routeStdout } from "./stdout";

routeStdout();

const main = defineCommand({
  meta: {
    name: "spec",
    version: packageJson.version,
    description: "Cross-repo spec engine",
  },
  subCommands: {
    index: () => import("./commands/index").then((m) => m.indexCommand),
    init: () => import("./commands/init").then((m) => m.initCommand),
    check: () => import("./commands/check").then((m) => m.checkCommand),
    domain: () => import("./commands/domain").then((m) => m.domainCommand),
    map: () => import("./commands/map").then((m) => m.mapCommand),
    get: () => import("./commands/get").then((m) => m.getCommand),
    list: () => import("./commands/list").then((m) => m.listCommand),
    propagation: () => import("./commands/propagation").then((m) => m.propagationCommand),
    query: () => import("./commands/query").then((m) => m.queryCommand),
    relations: () => import("./commands/relations").then((m) => m.relationsCommand),
    provenance: () => import("./commands/provenance").then((m) => m.provenanceCommand),
    req: () => import("./commands/req").then((m) => m.reqCommand),
    term: () => import("./commands/term").then((m) => m.termCommand),
    glossary: () => import("./commands/glossary").then((m) => m.glossaryCommand),
    supersede: () => import("./commands/supersede").then((m) => m.supersedeCommand),
    deprecate: () => import("./commands/deprecate").then((m) => m.deprecateCommand),
    move: () => import("./commands/move").then((m) => m.moveCommand),
    amend: () => import("./commands/amend").then((m) => m.amendCommand),
    accept: () => import("./commands/accept").then((m) => m.acceptCommand),
    lint: () => import("./commands/lint").then((m) => m.lintCommand),
    migrate: () => import("./commands/migrate").then((m) => m.migrateCommand),
    mcp: () => import("./commands/mcp").then((m) => m.mcpCommand),
    resolve: () => import("./commands/resolve").then((m) => m.resolveCommand),
    gate: () => import("./commands/gate").then((m) => m.gateCommand),
    guard: () => import("./commands/guard").then((m) => m.guardCommand),
    serve: () => import("./commands/serve").then((m) => m.serveCommand),
    docs: () => import("./commands/docs").then((m) => m.docsCommand),
    "__schema-smoke": () => import("./commands/__smoke").then((m) => m.schemaSmokeCommand),
    "__schema-mismatch-smoke": () =>
      import("./commands/__smoke").then((m) => m.schemaMismatchSmokeCommand),
  },
  async run({ rawArgs }) {
    // citty runs this root run() after a subcommand dispatch too; without the
    // empty-args guard every subcommand would print the help block.
    if (rawArgs.length === 0) {
      await showUsage(main);
    }
  },
});

runMain(main);
