---
title: Platform Mapping
description: How Spec Engine decides what a platform is, which repositories belong to it, and what each coverage column is named
---

:::note
This model lands with RED-187 (2 of 2), the ticket that moves discovery onto `@spec-engine/platform-map`.
:::

Spec Engine does not have its own idea of what a platform is. It takes membership and shape from [`@spec-engine/platform-map`](https://www.npmjs.com/package/@spec-engine/platform-map), the same package every tool built on Spec Engine uses, and adds exactly one fact of its own per member: the version pin. This page states the model in platform-map's vocabulary and names the requirement each rule carries.

## Two files, one convention

platform-map works from two small committed files that share one name, `platform-map.json`. Which one a file is depends on its keys.

**The platform file** lives at the platform root and declares the members:

```json
{ "name": "acme", "members": ["api", "webapp", "mobile", "shared"], "ignore": ["scratch"] }
```

**The leaf marker** lives inside each member and points back at the platform:

```json
{ "platform": "acme", "member": "api" }
```

Neither file contains a path. Members are child directories of the platform root, named after their member name. A checkout that lives somewhere else is recorded in the per-user file `~/.config/platform-map/platforms.json`, written by `platform-map link` and never committed.

Spec Engine adds one more committed file per member, `spec-engine.member.json`. It carries the member's pin and its scan ignore list, and it says nothing about membership:

```json
{ "specs": "spec-engine@17", "ignore": ["generated"] }
```

## The platform root

The platform root is the directory that holds the canonical `spec-engine/` tree. When the platform is declared, the same directory holds the platform file. Every `spec` command resolves its root through platform-map's `locate()`: from wherever the command ran, walk upward to the nearest directory holding a `platform-map.json` or a `.git` entry, stopping at the home directory or the filesystem root, then resolve a marker to its platform through the parent directory or the per-user file. A root that `locate()` finds but that holds no `spec-engine/` directory is not a Spec Engine platform, and the command exits 2. <!-- @spec INIT-024 -->

The platform version is derived, never authored. It is the maximum of the domain versions under `spec-engine/`. A domain file that fails to parse contributes nothing to that number and is reported as `INVALID_DOMAIN_FILE` at parse time; the walk itself never fails on it. <!-- @spec INIT-029 -->

## Members

A member is a name in the platform file's `members` list. Nothing else makes a directory a member: not a `.git` entry, not a `package.json`, not a `spec-engine.member.json`. A repository sitting in the platform folder that nobody declared is platform-map's `UNLISTED_REPO`, and `spec check` reports it so the repository's `@spec` tags never go unscanned in silence.

A declared member that has no `spec-engine.member.json` is a member without a pin. The index reports it as `NO_SPEC_CONFIG`, one warning per member, and suggests `spec init <name>`. <!-- @spec INIT-022 --> When stdin is a terminal and `--no-prompt` is absent, an index-building command offers to run `spec init` for each such member before it proceeds. The prompt covers declared members only; declaring a repository is `platform-map init`, not `spec init`. <!-- @spec INIT-023 -->

A member's pin is the `specs` string in its `spec-engine.member.json`, one platform-wide scalar `spec-engine@N`. Its `ignore` list names repo-relative directory prefixes the tag scanner skips inside that member. The platform file's own `ignore` list is different: it names directories platform-map skips during discovery, so they are never candidates and never `UNLISTED_REPO`.

## Monorepo members and their packages

platform-map classifies every member as `single-repo` or `monorepo` from its ecosystem's workspace manifest: `pnpm-workspace.yaml`, `package.json` `workspaces`, `lerna.json`, a `uv` workspace, a Cargo workspace, or `go.work`. A monorepo member's packages are the directories its workspace manifest lists.

Each package is its own coverage column, named by the package's path relative to the member (`packages/ui`), prefixed by the member name when the member belongs to a declared platform (`shared/packages/ui`). A package inherits its member's pin unless it carries a nested `spec-engine.member.json`, whose pin and `ignore` then apply to that package alone. That is how one package can sit on `spec-engine@2` while a sibling lags on `@1`.

There is no `members` glob in `spec-engine.member.json`. The workspace manifest is the one place a monorepo names its packages.

## A lone repository

A repository that holds its own `spec-engine/` tree and is not a declared platform is a lone repository. platform-map maps it as `single-repo` or `monorepo` with one repo entry, and Spec Engine scans that repo without any member config or CI gate. <!-- @spec INIT-026 -->

A lone `single-repo` is one coverage column named by the directory name. A lone `monorepo` has one coverage column per workspace package, named by the package's repo-relative path (`packages/engine`), with no member prefix. Every lone-repository column, and the canonical `spec-engine` row itself, is pinned to the derived platform version, so a repository is never reported drifted against its own working-tree domains. A nested `spec-engine.member.json` inside a package still overrides that package's pin. <!-- @spec INIT-028 -->

This repository is a lone `monorepo`. Its coverage columns are `packages/engine`, `packages/shared`, `packages/site`, `packages/tracker`, `packages/webapp`, and `scripts`, each a workspace package of the root `package.json`.

## Names

One name serves everywhere. For a declared member it is the member name from the platform file. For a package it is the member name and the package path joined by `/`, or the bare package path in a lone monorepo. That same string is:

- the coverage column in `spec map`,
- the prefix of every `tags.file` value, so `spec resolve <name>/<path>` finds the tag,
- the `repo` argument of `spec gate <repo> <KEY-NNN>`,
- the `repo` field of every `spec propagation` row.

The canonical `spec-engine/` tree is one more row named `spec-engine`. It holds requirement text, never code, and the webapp excludes it from every member count.

## Diagnostics

platform-map reports what it finds as diagnostics on the map. `spec check` surfaces the ones that describe a broken or incomplete platform as rows of its own, with the platform-map code, so a broken platform declaration fails the same gate a broken requirement does.

| platform-map code | platform-map severity | `spec check` severity | Meaning |
| --- | --- | --- | --- |
| `MALFORMED_FILE` | error, or warning for a manifest | same | A `platform-map.json`, a manifest, or the per-user file failed to parse or validate |
| `MARKER_MISMATCH` | error | error | A member's marker names a different platform |
| `MEMBER_MISSING` | warning | warning | A declared member is not on this machine; it is not scanned |
| `MARKER_MISSING` | warning | warning | A declared member has no marker |
| `PLATFORM_NOT_LOCATED` | warning | warning | A marker names a platform this machine cannot find |
| `SCAN_TRUNCATED` | warning | warning | A directory walk hit its depth or entry cap |
| `UNLISTED_REPO` | info | warning | A repository in the platform folder is not a member; its tags are not scanned |
| `UNDECLARED_PLATFORM` | info | warning | A folder of repositories with no platform file; nothing in it is a member until `platform-map init` runs |
| `UNMATCHED_PATTERN` | info | not surfaced | A workspace glob matched no package |
| `AMBIGUOUS_ECOSYSTEM` | info | not surfaced | A repo has manifests from more than one ecosystem |

The rule behind the table: every platform-map error and warning keeps its severity, and an info diagnostic is promoted to a warning only when it means a repository's tags are silently not being scanned. `NO_SPEC_CONFIG` stays Spec Engine's own code, because the pin is Spec Engine's own file.

## Where `spec init` may write

`spec init <dir>` writes a member's `spec-engine.member.json`. It resolves symlinks, locates the platform root, and refuses two targets with exit 2: a directory inside a `spec-engine/` tree, because a pin there registers the requirement source as a member of itself, and the platform root itself, because the root is not a member. <!-- @spec INIT-018 -->

The refusal reads every path segment for the name `spec-engine`. On the engine's own checkout, whose root package is named `@spec-engine/spec-engine`, only the path below the platform root is judged, so a checkout named `spec-engine` can still scaffold its own packages. <!-- @spec INIT-030 -->

The default pin is the derived platform version. With no located platform, `spec init` writes `spec-engine@1` and says so.

## The webapp's scan-mode tile

The Setup page's scan-mode tile is `map().mode` rendered in words: `monorepo` renders Monorepo, `multi-repo` renders Platform, and `single-repo` renders Single repo. <!-- @spec SERV-017 -->

## Determinism

`map()` contains no absolute path and sorts every array with plain string comparison, so the same files and the same disk produce the same map from any directory. Spec Engine reads paths from `locate()`, which is never part of the map, and hashes none of them into `build_id`. Deleting `.spec-engine/` and rebuilding produces the identical index and the identical `build_id`. <!-- @spec INDX-007 --> `spec index` walks the spec directory and every present member and package, and reports the `build_id` and the row counts. <!-- @spec INDX-009 -->

## Declaring a platform

```bash
cd ~/clients/acme                         # the folder holding the repos
npx @spec-engine/platform-map init --yes  # platform file plus one marker per repo
spec domain new BILLING                   # the canonical tree makes it a Spec Engine platform
spec init api && spec init webapp         # a pin per member
spec index . && spec check . --ci         # membership and pins are now one gate
```

`platform-map check .` in CI fails when the files and the disk disagree. `spec check . --ci` fails when a requirement, a tag, a pin, or the platform is broken.

## A future input: `dependsOn`

Every repo and package in the map carries `dependsOn`, the platform's own package names it depends on. Spec Engine does not read it yet. It is the natural ordering input for propagation across members and is recorded here so the migration leaves room for it.
