// packages/engine/test/discover.test.ts
//
// Dogfood (spec self-consumes this repo — see spec-engine/):
// @spec INIT-006
//
// DISC-02 substrate regression suite for `discoverRepos`. Locks the
// Phase 7 widened return shape `{ canonical, platformVersion, members,
// skipped }` (platformVersion DERIVED per RED-85 — max domain version, the
// authored spec-engine.platform.json manifest is retired) and the
// case-2-only capture contract (directory exists but lacks
// `spec-engine.member.json`) against tmp platforms composed via
// `mkdtempSync` + `mkdir` + `writeFile` per the cold-rebuild.test.ts
// hermetic pattern.
//
// Storage-free: this file imports zero from `bun:sqlite` (Pitfall 5 —
// D-08 grep-fence remains at exactly 1 src-side `bun:sqlite` import
// system-wide, in `storage/sqlite.ts:7`).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { NotASpecPlatformError } from "@spec-engine/shared";
import { assertSpecPlatform, discoverRepos, readRepoConfig } from "../src/indexer/discover";
import { writeVersionedDomain } from "./fixtures/versionedDomain";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "spec-discover-test-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("discoverRepos skipped[] field (DISC-02)", () => {
  test("(a) sibling repo-root without spec-engine.member.json produces one skipped entry", async () => {
    await mkdir(join(tmp, "spec-engine"), { recursive: true });
    await mkdir(join(tmp, "strangers"), { recursive: true });
    // RUNG1-02 repo-root signal: a config-less child counts as a SKIPPED
    // sibling ONLY if it looks like a repo root (.git or package.json). A
    // bare `strangers/` dir with no marker is bucket-3 (plain folder) and is
    // ignored entirely. Give it a package.json so it is a real unwired
    // member repo → skipped.length === 1, which is the v1.1 behavior under
    // test here (and which would suppress the self-member).
    await writeFile(join(tmp, "strangers", "package.json"), JSON.stringify({ name: "strangers" }));

    const r = await discoverRepos(tmp);

    expect(r.skipped.length).toBe(1);
    expect(r.skipped[0]?.name).toBe("strangers");
    expect(r.skipped[0]?.path).toBe(join(tmp, "strangers"));
    // A skipped sibling exists → self-member mode does NOT fire.
    expect(r.members.length).toBe(0);
  });

  test("(b) loose file at platform root produces zero skipped entries + registers the self-member (DISC-02 exclusion + RUNG1-01)", async () => {
    // Use a non-dot-prefixed file so Bun.Glob with `dot: false` still
    // enumerates the entry — the test then actually exercises the
    // `isDirectory()` filter in discoverRepos (line 138). A dotfile
    // like `.gitkeep` would be filtered at the glob layer and never
    // reach the directory check, giving a false signal that the filter
    // is covered.
    await mkdir(join(tmp, "spec-engine"), { recursive: true });
    await writeFile(join(tmp, "README.md"), "loose file at platform root");

    const r = await discoverRepos(tmp);

    // skipped[] still empty — a loose FILE is never a sibling.
    expect(r.skipped.length).toBe(0);
    // INTENDED new self-member behavior (RUNG1-01), NOT a fixture
    // workaround: a `spec-engine/` + loose-files-only directory has zero
    // sibling members and zero skipped siblings, so the lone repo
    // correctly self-consumes — the platform root is registered as its
    // OWN member (basename name, selfMember flag). A loose file at the
    // root does NOT make the dir multi-repo.
    expect(r.members.length).toBe(1);
    expect(r.members[0]?.selfMember).toBe(true);
    expect(r.members[0]?.name).toBe(basename(resolve(tmp)));
  });

  test("(c) malformed spec-engine.member.json still throws (DISC-02 case 3 regression)", async () => {
    await mkdir(join(tmp, "spec-engine"), { recursive: true });
    await mkdir(join(tmp, "member"), { recursive: true });
    await writeFile(join(tmp, "member", "spec-engine.member.json"), "{not valid json");

    await expect(discoverRepos(tmp)).rejects.toThrow(/failed to parse|failed validation/);
  });

  test("(d) two repo-root siblings without configs return in lex-by-name order (Pitfall 3 inheritance)", async () => {
    await mkdir(join(tmp, "spec-engine"), { recursive: true });
    await mkdir(join(tmp, "zulu"), { recursive: true });
    await mkdir(join(tmp, "alpha"), { recursive: true });
    // RUNG1-02: both must carry a repo-root marker to be counted as skipped
    // siblings (else they'd be bucket-3 plain folders and ignored). Use `.git`
    // dirs to exercise the directory-form `.git` marker.
    await mkdir(join(tmp, "zulu", ".git"), { recursive: true });
    await mkdir(join(tmp, "alpha", ".git"), { recursive: true });

    const r = await discoverRepos(tmp);

    expect(r.skipped.length).toBe(2);
    expect(r.skipped[0]?.name).toBe("alpha");
    expect(r.skipped[1]?.name).toBe("zulu");
  });

  test("(e) RUNG1-02: a config-less plain folder (no .git/package.json) is NOT a sibling and does NOT suppress the self-member", async () => {
    // The exact realistic single-repo shape that the original trigger broke:
    // code in `src/`/`test/` subdirs. Neither subdir is a repo root, so both
    // are bucket-3 (ignored) — skipped stays empty, the self-member fires,
    // and the platform root's own tree (incl. src/ + test/) is scanned.
    await mkdir(join(tmp, "spec-engine"), { recursive: true });
    await mkdir(join(tmp, "src"), { recursive: true });
    await mkdir(join(tmp, "test"), { recursive: true });

    const r = await discoverRepos(tmp);

    // Neither plain folder enumerates as a skipped sibling.
    expect(r.skipped.length).toBe(0);
    // Self-member fires because skipped is empty.
    expect(r.members.length).toBe(1);
    expect(r.members[0]?.selfMember).toBe(true);
    expect(r.members[0]?.name).toBe(basename(resolve(tmp)));
  });

  test("(f) RUNG1-02: a config-less child WITH a repo-root marker IS skipped (v1.1 unwired-member intent preserved)", async () => {
    // The mirror of (e): a real unwired member repo always has .git /
    // package.json, so it must STILL trip the skip path → NO_SPEC_CONFIG.
    await mkdir(join(tmp, "spec-engine"), { recursive: true });
    await mkdir(join(tmp, "member-app"), { recursive: true });
    await writeFile(
      join(tmp, "member-app", "package.json"),
      JSON.stringify({ name: "member-app" }),
    );

    const r = await discoverRepos(tmp);

    expect(r.skipped.length).toBe(1);
    expect(r.skipped[0]?.name).toBe("member-app");
    // A skipped sibling suppresses the self-member (user is mid-onboarding).
    expect(r.members.length).toBe(0);
  });
});

describe("discoverRepos self-member / single-repo mode (RUNG1-01)", () => {
  // @spec INIT-014 unit
  test("(1) lone repo (spec-engine/ only, no siblings, no loose files) registers exactly one self-member", async () => {
    // A domain at derived version 3 (two supersede edges) — the self-member
    // pin must TRACK it, not sit on a stale authored counter (RED-85).
    await writeVersionedDomain(tmp, "ALPHA", 3);

    const r = await discoverRepos(tmp);

    expect(r.skipped.length).toBe(0);
    expect(r.members.length).toBe(1);
    expect(r.members[0]?.selfMember).toBe(true);
    expect(r.members[0]?.name).toBe(basename(resolve(tmp)));
    expect(r.members[0]?.path).toBe(resolve(tmp));
    // pin === derived platformVersion → DRIFT structurally impossible for
    // requirement domains (D-03, revised by RED-85): changed_at_version never
    // exceeds its domain's derived version, which never exceeds the max.
    expect(r.members[0]?.pinned_spec_version).toBe(r.platformVersion);
    expect(r.members[0]?.pinned_spec_version).toBe(3);
  });

  test("(2) spec-engine/ + one sibling DIR with spec-engine.member.json → NO self-member (multi-repo unchanged)", async () => {
    await mkdir(join(tmp, "spec-engine"), { recursive: true });
    await mkdir(join(tmp, "api"), { recursive: true });
    await writeFile(
      join(tmp, "api", "spec-engine.member.json"),
      JSON.stringify({ specs: "spec-engine@1" }),
    );

    const r = await discoverRepos(tmp);

    expect(r.skipped.length).toBe(0);
    expect(r.members.length).toBe(1);
    // The lone member is the real sibling — NOT a self-member.
    expect(r.members[0]?.name).toBe("api");
    expect(r.members[0]?.selfMember).toBeUndefined();
  });

  test("(3) spec-engine/ + one skipped sibling (repo-root, no config) → NO self-member; no selfMember flag leaks", async () => {
    await mkdir(join(tmp, "spec-engine"), { recursive: true });
    await mkdir(join(tmp, "strangers"), { recursive: true });
    // RUNG1-02: marker required for `strangers/` to count as a skipped sibling.
    await mkdir(join(tmp, "strangers", ".git"), { recursive: true });

    const r = await discoverRepos(tmp);

    expect(r.skipped.length).toBe(1);
    expect(r.skipped[0]?.name).toBe("strangers");
    // Self-member mode is the truly-lone-repo shape ONLY: a skipped
    // sibling suppresses it (the user is mid-onboarding).
    expect(r.members.length).toBe(0);
    expect(r.members.some((c) => c.selfMember)).toBe(false);
  });
});

describe("discoverRepos workspace expansion (2.7)", () => {
  async function buildMonorepo(): Promise<void> {
    await mkdir(join(tmp, "spec-engine"), { recursive: true });
    // The member config lives at packages/ and expands its immediate subdirs.
    await mkdir(join(tmp, "packages", "engine"), { recursive: true });
    await mkdir(join(tmp, "packages", "shared"), { recursive: true });
    await writeFile(
      join(tmp, "packages", "spec-engine.member.json"),
      JSON.stringify({ specs: "spec-engine@1", members: "*" }),
    );
    await writeFile(
      join(tmp, "packages", "engine", "package.json"),
      JSON.stringify({ name: "engine" }),
    );
    await writeFile(
      join(tmp, "packages", "shared", "package.json"),
      JSON.stringify({ name: "shared" }),
    );
  }

  test("(g) a `members` glob expands into one sub-member per subdirectory, named by platform-relative path", async () => {
    await buildMonorepo();
    const r = await discoverRepos(tmp);

    // engine + shared each get their OWN member row — no collapsed `packages` blob.
    expect(r.members.map((m) => m.name)).toEqual(["packages/engine", "packages/shared"]);
    expect(r.members.every((m) => m.selfMember === undefined)).toBe(true);
    // Paths point at the real subdirectories.
    expect(r.members[0]?.path).toBe(join(tmp, "packages", "engine"));
    // No standalone `packages` member survived the expansion.
    expect(r.members.some((m) => m.name === "packages")).toBe(false);
  });

  test("(h) sub-members inherit the parent pin unless they carry their own config", async () => {
    await buildMonorepo();
    // Give shared its own nested config pinning spec-engine@2.
    await writeFile(
      join(tmp, "packages", "shared", "spec-engine.member.json"),
      JSON.stringify({ specs: "spec-engine@2" }),
    );
    const r = await discoverRepos(tmp);

    const engine = r.members.find((m) => m.name === "packages/engine");
    const shared = r.members.find((m) => m.name === "packages/shared");
    expect(engine?.pinned_spec_version).toBe(1); // inherited parent pin
    expect(shared?.pinned_spec_version).toBe(2); // own nested pin wins
  });

  test("(i) the config file itself and a spec-engine dir are never expanded into members", async () => {
    await mkdir(join(tmp, "spec-engine"), { recursive: true });
    await mkdir(join(tmp, "packages", "real"), { recursive: true });
    await mkdir(join(tmp, "packages", "spec-engine"), { recursive: true });
    await writeFile(
      join(tmp, "packages", "spec-engine.member.json"),
      JSON.stringify({ specs: "spec-engine@1", members: "*" }),
    );
    const r = await discoverRepos(tmp);

    // Only the real subdir; the glob-matched config file (not a dir) and the
    // `spec-engine` subdir (would shadow the canonical row) are both dropped.
    expect(r.members.map((m) => m.name)).toEqual(["packages/real"]);
  });
});

describe("discoverRepos missing-canonical sentinel (260605-g84 B.2)", () => {
  test("rejects with NotASpecPlatformError carrying the resolved platformDir when spec-engine/ is absent", async () => {
    // tmp exists but has NO spec-engine/ subdirectory.
    let caught: unknown;
    try {
      await discoverRepos(tmp);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(NotASpecPlatformError);
    // The sentinel carries the RESOLVED absolute platform dir so the command
    // boundaries can render it verbatim in the friendly message.
    expect((caught as NotASpecPlatformError).platformDir).toBe(resolve(tmp));
  });
});

describe("assertSpecPlatform pre-flight guard (260605-g84 follow-up)", () => {
  test("throws NotASpecPlatformError (with resolved dir) when spec-engine/ is absent", () => {
    // The lightweight guard the command boundaries call BEFORE
    // mkdirSync(.spec-engine)/openStorage — same sentinel as discoverRepos, but
    // synchronous and index-free so a failed build leaves no artifact.
    let caught: unknown;
    try {
      assertSpecPlatform(tmp);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(NotASpecPlatformError);
    expect((caught as NotASpecPlatformError).platformDir).toBe(resolve(tmp));
  });

  test("does NOT throw when spec-engine/ exists (even with zero requirements)", async () => {
    // Boundary parity with B.1: a real (if empty) platform must pass the
    // guard so the indexed-but-empty path still runs. The guard fires ONLY
    // on absence, never on emptiness.
    await mkdir(join(tmp, "spec-engine"), { recursive: true });
    expect(() => assertSpecPlatform(tmp)).not.toThrow();
  });
});

// ----------------------------------------------------------------------------
// RED-14 dead-end audit: readRepoConfig's three-layer error contract existed
// without a covering test (only the member-config parse-fail layer was
// exercised, via discoverRepos test (c) above). The companion manifest
// read/parse/validate suite is gone with the manifest itself (RED-85) —
// replaced by the derived-platform-version describe block below.
// ----------------------------------------------------------------------------

describe("readRepoConfig three-layer error contract (RED-14)", () => {
  test("unreadable path (a directory at the config path) → 'could not be read'", async () => {
    // A directory named spec-engine.member.json: existsSync passes upstream, but
    // Bun.file(...).text() throws — the layer-1 wrap must surface it.
    const configPath = join(tmp, "spec-engine.member.json");
    await mkdir(configPath, { recursive: true });

    await expect(readRepoConfig(configPath)).rejects.toThrow(/could not be read/);
  });

  test("syntactically-valid JSON failing the pin schema → 'failed validation'", async () => {
    const configPath = join(tmp, "spec-engine.member.json");
    await writeFile(configPath, JSON.stringify({ specs: "not-a-pin" }));

    await expect(readRepoConfig(configPath)).rejects.toThrow(/failed validation/);
  });

  test("malformed JSON → 'failed to parse as JSON'", async () => {
    const configPath = join(tmp, "spec-engine.member.json");
    await writeFile(configPath, "{nope");

    await expect(readRepoConfig(configPath)).rejects.toThrow(/failed to parse as JSON/);
  });
});

describe("derived platform version in discoverRepos (RED-85)", () => {
  // @spec SCHM-009 unit
  test("platformVersion = max domain version across the platform's SPEC.json files", async () => {
    await writeVersionedDomain(tmp, "ALPHA", 4);
    await writeVersionedDomain(tmp, "BETA", 2);

    const r = await discoverRepos(tmp);

    expect(r.platformVersion).toBe(4);
    // The canonical spec-engine row is pinned to the derived version too (INIT-014).
    expect(r.canonical.pinned_spec_version).toBe(4);
  });

  test("stray retired spec-engine.platform.json is ignored, never parsed — even malformed (RED-85)", async () => {
    await writeVersionedDomain(tmp, "ALPHA", 2);
    // Malformed on purpose: the old reader would have thrown 'failed to
    // parse as JSON' here. The retired manifest must contribute nothing.
    await writeFile(join(tmp, "spec-engine", "spec-engine.platform.json"), "{nope");

    const r = await discoverRepos(tmp);

    expect(r.platformVersion).toBe(2);
  });

  test("a domain SPEC.json the reader rejects contributes nothing (lenient derivation)", async () => {
    await writeVersionedDomain(tmp, "ALPHA", 3);
    await mkdir(join(tmp, "spec-engine", "BROKEN"), { recursive: true });
    await writeFile(join(tmp, "spec-engine", "BROKEN", "SPEC.json"), "{nope");

    const r = await discoverRepos(tmp);

    // The loud INVALID_DOMAIN_FILE reject belongs to the parse stage;
    // derivation just skips the file.
    expect(r.platformVersion).toBe(3);
  });
});
