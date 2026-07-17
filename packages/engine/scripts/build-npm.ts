// packages/engine/scripts/build-npm.ts
//
// Dogfood (spec self-consumes this repo — see spec-engine/):
// @spec DIST-004
//
// Builds the publishable npm payload for @spec-engine/spec-engine (single
// bundled package — webapp and docs ship INSIDE the CLI). Wired to `prepack`,
// so both `bun pm pack` and `bun publish` rebuild it; it never runs on
// install. Publish with `bun publish` (the directory, never a pre-packed
// tarball — a tarball path skips lifecycle scripts, and only bun rewrites
// any residual workspace: protocol).
//
//   dist/impl.js — src/cli.ts bundled for the Bun runtime. Workspace packages
//                  (@spec-engine/shared|tracker|webapp) inline into the
//                  bundle; the manifest `dependencies` stay --external and
//                  install from the registry.
//   dist/cli.js  — the bin entry (npm-wrapper.ts): Bun-runtime guard, THEN a
//                  dynamic import of impl.js.
//   dist/docs/   — the prebuilt Starlight site (packages/site), so
//                  `spec docs` serves documentation fully offline.

import { existsSync } from "node:fs";
import { chmod, cp, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { $ } from "bun";
import { wrapperSource } from "./npm-wrapper";

const engineDir = resolve(import.meta.dir, "..");
const siteDir = resolve(engineDir, "..", "site");
const dist = join(engineDir, "dist");

// The externals ARE the manifest dependencies — one source, no drift: a dep
// added to package.json is automatically kept external, everything else
// (workspace packages included) bundles in.
const pkg = (await Bun.file(join(engineDir, "package.json")).json()) as {
  dependencies?: Record<string, string>;
};
const externals = Object.keys(pkg.dependencies ?? {});

await rm(dist, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: [join(engineDir, "src", "cli.ts")],
  outdir: dist,
  target: "bun",
  external: externals,
});
if (!result.success) {
  for (const log of result.logs) console.error(String(log));
  console.error("build:npm: bundle failed");
  process.exit(1);
}

// One entrypoint, no splitting → exactly one .js output. A second file means
// the wrapper's hardcoded `./impl.js` contract is broken — fail loudly.
const jsOutputs = result.outputs.filter((o) => o.path.endsWith(".js"));
const bundle = jsOutputs[0];
if (!bundle || jsOutputs.length !== 1) {
  console.error(`build:npm: expected exactly 1 bundle output, got ${jsOutputs.length}`);
  process.exit(1);
}
await rename(bundle.path, join(dist, "impl.js"));

await Bun.write(join(dist, "cli.js"), wrapperSource);
await chmod(join(dist, "cli.js"), 0o755);

// Docs payload: build the Starlight site, then vendor its dist.
await $`bun run build`.cwd(siteDir);
const siteOut = join(siteDir, "dist");
if (!existsSync(join(siteOut, "index.html"))) {
  console.error("build:npm: packages/site/dist/index.html missing after astro build");
  process.exit(1);
}
await cp(siteOut, join(dist, "docs"), { recursive: true });

console.error("build:npm: dist/impl.js + dist/cli.js + dist/docs/ ready");
