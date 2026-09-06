// packages/engine/src/testing/platform.ts
//
// The one platform builder a test uses to author its fixture. Every SPEC.json
// it produces is written by the same operations a user reaches through the
// CLI, the API, or MCP, so a test never restates the envelope shape. The
// builder itself serializes nothing; a state the engine refuses to author
// (a removed entry, an unapproved status flip, a broken pointer) is planted
// through `plantEdit` in ./plant.ts, and a schema-invalid file lives under
// ./fixtures/.

import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { applyInit } from "@spec-engine/platform-map";
import { type SpecCite, type SpecDomain, validateDomainFile } from "@spec-engine/shared";
import { CANONICAL_SPECS_DIR, SPEC_FILENAME, specPaths } from "../constants";
import type { FreshTags } from "../operations/_index";
import type { OpFailure } from "../operations/_result";
import { type AmendFields, type AmendResult, amend } from "../operations/amend";
import { type DeprecateResult, deprecate } from "../operations/deprecate";
import { type NewDomainOptions, newDomain } from "../operations/domain";
import { initMember, planDeclare } from "../operations/init";
import { type MintResult, mint } from "../operations/mint";
import { type MoveResult, move } from "../operations/move";
import { nextId } from "../operations/nextId";
import { type SupersedeResult, supersede } from "../operations/supersede";
import {
  type ConfirmTermResult,
  confirmTerm,
  type MintTermResult,
  mintTerm,
  type ReviseTermResult,
  reviseTerm,
  TERM_KEY,
} from "../operations/term";

/** A fixture has no index; a lifecycle write asks for none. */
const noTags: FreshTags = async () => [];

/** An operation refusal is a test-setup bug, so it throws with the typed reason. */
function unwrap<T extends { ok: true }>(result: T | OpFailure, what: string): T {
  if (!result.ok) throw new Error(`${what} refused (${result.reason}): ${result.detail}`);
  return result;
}

export interface RequirementInput {
  /** Defaults to an EARS-shaped placeholder naming the minted id. */
  statement?: string;
  why?: string;
  livesIn?: string[];
  issue?: string;
  status?: "active" | "draft";
  relates?: string[];
  cites?: SpecCite[];
}

export interface SuccessorInput {
  /** Defaults to an EARS-shaped placeholder naming the successor id. */
  statement?: string;
  why?: string;
  livesIn?: string[];
  issue?: string;
  term?: string;
  aliases?: string[];
  noBump?: boolean;
}

export interface TermInput {
  term: string;
  definition: string;
  aliases?: string[];
  section?: string;
}

export interface MemberInput {
  /** Defaults to `spec-engine@1`. */
  pin?: string | undefined;
  ignore?: string[] | undefined;
  /** Repo-relative files to write, e.g. a source file carrying a tag line. */
  files?: Record<string, string> | undefined;
  /** Package names this member's manifest lists under `dependencies`; platform-map reads them as `dependsOn`. */
  dependsOn?: string[] | undefined;
}

export interface MintedRequirement {
  id: string;
}

/** A `dependencies` map over the given package names, each at any version. */
export function dependencies(names: readonly string[]): Record<string, string> {
  return Object.fromEntries(names.map((n) => [n, "*"]));
}

/** A private package manifest naming the directory, so platform-map reads it as a repository or package. */
function manifest(dir: string, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ name: basename(dir), private: true, ...extra }, null, 2)}\n`;
}

/** A directory the builder writes plain files into. Never a spec file. */
abstract class FileTree {
  abstract readonly dir: string;

  /** Write this directory's `package.json`: a private manifest named after the directory, plus `extra`. */
  manifest(extra: Record<string, unknown> = {}): string {
    return this.file("package.json", manifest(this.dir, extra));
  }

  /**
   * Make this directory a monorepo of the given workspace packages: a root
   * manifest listing them under `workspaces` and a manifest in each package.
   * A package directory not yet present is created.
   */
  workspace(packages: string[], extra: Record<string, unknown> = {}): void {
    this.manifest({ workspaces: packages, ...extra });
    for (const pkg of packages) this.file(join(pkg, "package.json"), manifest(join(this.dir, pkg)));
  }

  /** Write a non-spec file under this tree and return its absolute path. */
  file(rel: string, content: string): string {
    if (basename(rel) === SPEC_FILENAME) {
      throw new Error(`refusing to write ${rel} by hand; author it through an operation`);
    }
    const abs = join(this.dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    return abs;
  }
}

export class MemberHandle extends FileTree {
  constructor(
    readonly name: string,
    readonly dir: string,
  ) {
    super();
  }
}

export class DomainHandle {
  constructor(
    readonly platform: TestPlatform,
    readonly key: string,
  ) {}

  /** Absolute path of the domain's SPEC.json. */
  get file(): string {
    return specPaths(this.platform.dir, this.key).abs;
  }

  /** Platform-relative path, e.g. `spec-engine/BILLING/SPEC.json`. */
  get relFile(): string {
    return specPaths(this.platform.dir, this.key).rel;
  }

  /** The envelope as the schema reads it. Throws when the file is invalid. */
  async read(): Promise<SpecDomain> {
    const parsed = validateDomainFile(JSON.parse(await Bun.file(this.file).text()), this.relFile);
    if (!parsed.ok) {
      throw new Error(
        `${this.relFile} is invalid: ${parsed.diagnostics.map((d) => d.detail).join("; ")}`,
      );
    }
    return parsed.data;
  }

  /** The raw bytes on disk, for byte-identity assertions. */
  raw(): Promise<string> {
    return Bun.file(this.file).text();
  }

  /** The next id `mint` would allocate. Nothing is written. */
  async nextId(): Promise<string> {
    return unwrap(await nextId(this.platform.dir, this.key), `next id in ${this.key}`).nextId;
  }

  async req(input: RequirementInput = {}): Promise<MintResult> {
    const id = await this.nextId();
    return unwrap(
      await mint({
        platformDir: this.platform.dir,
        key: this.key,
        statement: input.statement ?? placeholderStatement(id),
        why: input.why ?? "",
        livesIn: input.livesIn ?? [],
        issue: input.issue,
        status: input.status,
        relates: input.relates,
        cites: input.cites,
      }),
      `mint in ${this.key}`,
    );
  }

  /** Mint `count` Active requirements with placeholder text; returns their ids in order. */
  async reqs(count: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) ids.push((await this.req()).id);
    return ids;
  }

  /**
   * A supersede chain of `length` entries: one Active head and `length - 1`
   * superseded predecessors, so the domain's derived version is `length`.
   * Returns the ids oldest first.
   */
  async chain(length: number): Promise<string[]> {
    const ids = [(await this.req()).id];
    while (ids.length < length) {
      const previous = ids[ids.length - 1] as string;
      ids.push((await this.supersede(previous)).newId);
    }
    return ids;
  }

  async supersede(id: string, input: SuccessorInput = {}): Promise<SupersedeResult> {
    const successor = await this.nextId();
    return unwrap(
      await supersede(
        {
          platformDir: this.platform.dir,
          id,
          statement: input.statement ?? placeholderStatement(successor),
          why: input.why,
          livesIn: input.livesIn,
          issue: input.issue,
          term: input.term,
          aliases: input.aliases,
          noBump: input.noBump,
        },
        noTags,
      ),
      `supersede ${id}`,
    );
  }

  async deprecate(id: string, reason = "retired by the test"): Promise<DeprecateResult> {
    return unwrap(
      await deprecate({ platformDir: this.platform.dir, id, reason }, noTags),
      `deprecate ${id}`,
    );
  }

  /** Amend in place. The fixture has no index, so the bound-tag gate sees no tags. */
  async amend(id: string, fields: AmendFields): Promise<AmendResult> {
    return unwrap(
      await amend({ platformDir: this.platform.dir, id, fields }, noTags),
      `amend ${id}`,
    );
  }

  /** Cross-domain supersede into `targetKey`, which must already be scaffolded. */
  async moveTo(
    id: string,
    targetKey: string,
    input: Pick<SuccessorInput, "statement" | "why" | "livesIn"> = {},
  ): Promise<MoveResult> {
    return unwrap(
      await move(
        {
          platformDir: this.platform.dir,
          id,
          targetKey,
          statement: input.statement,
          why: input.why,
          livesIn: input.livesIn,
        },
        noTags,
      ),
      `move ${id} to ${targetKey}`,
    );
  }
}

function placeholderStatement(id: string): string {
  return `The system shall satisfy ${id}.`;
}

/**
 * A platform directory a test authors through the operations.
 * @spec SCHM-026
 */
export class TestPlatform extends FileTree {
  private constructor(readonly dir: string) {
    super();
    mkdirSync(join(dir, CANONICAL_SPECS_DIR), { recursive: true });
  }

  /** A fresh platform under the OS temp dir. Remove it with `remove()`. */
  static temp(prefix = "spec-platform-"): TestPlatform {
    return new TestPlatform(mkdtempSync(join(tmpdir(), prefix)));
  }

  /** A platform at an existing directory (the `spec-engine/` folder is created). */
  static at(dir: string): TestPlatform {
    return new TestPlatform(dir);
  }

  remove(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }

  /**
   * Copy every spec file aside and return the function that puts the copies
   * back, so a test can run the same write from the same starting bytes
   * through several surfaces. A restore is a file copy, never a serialization.
   */
  snapshotSpecs(): () => void {
    const specs = join(this.dir, CANONICAL_SPECS_DIR);
    const copy = mkdtempSync(join(tmpdir(), "spec-snapshot-"));
    cpSync(specs, copy, { recursive: true });
    return () => {
      rmSync(specs, { recursive: true, force: true });
      cpSync(copy, specs, { recursive: true });
    };
  }

  /** Absolute path of a domain's SPEC.json, scaffolded or not. */
  specFile(key: string): string {
    return specPaths(this.dir, key).abs;
  }

  /** The domain's handle without scaffolding it (for a domain another call created). */
  handle(key: string): DomainHandle {
    return new DomainHandle(this, key);
  }

  async domain(key: string, options: NewDomainOptions = {}): Promise<DomainHandle> {
    unwrap(await newDomain(this.dir, key, options), `scaffold ${key}`);
    return this.handle(key);
  }

  /** The reserved TERM store, scaffolded with its authored `specVersion`. */
  terms(options: NewDomainOptions = {}): Promise<DomainHandle> {
    return this.domain(TERM_KEY, options);
  }

  async term(input: TermInput): Promise<MintTermResult> {
    return unwrap(
      await mintTerm({
        platformDir: this.dir,
        term: input.term,
        definition: input.definition,
        aliases: input.aliases ?? [],
        section: input.section,
      }),
      `mint term ${input.term}`,
    );
  }

  async reviseTerm(id: string, definition: string, noBump = false): Promise<ReviseTermResult> {
    return unwrap(
      await reviseTerm({ platformDir: this.dir, id, definition, noBump }),
      `revise ${id}`,
    );
  }

  async confirmTerm(reqId: string, termId: string): Promise<ConfirmTermResult> {
    return unwrap(await confirmTerm({ platformDir: this.dir, reqId, termId }), `confirm ${reqId}`);
  }

  /**
   * A repository directory in the platform folder: a private `package.json`
   * makes it a repository platform-map can declare. Not a member until
   * `member()` declares it; until then it is what `spec check` reports as
   * `UNLISTED_REPO`.
   */
  repository(name: string, files: Record<string, string> = {}): MemberHandle {
    const handle = new MemberHandle(name, join(this.dir, name));
    mkdirSync(handle.dir, { recursive: true });
    handle.manifest();
    for (const [rel, content] of Object.entries(files)) handle.file(rel, content);
    return handle;
  }

  /**
   * A declared member with its pin, written by the same operation `spec init`
   * runs: the platform file entry, the marker, and `spec-engine.member.json`.
   */
  async member(name: string, input: MemberInput = {}): Promise<MemberHandle> {
    const handle = this.repository(name, input.files);
    if (input.dependsOn !== undefined)
      handle.manifest({ dependencies: dependencies(input.dependsOn) });
    unwrap(
      await initMember({
        repoDir: handle.dir,
        override: input.pin ?? "spec-engine@1",
        ignore: input.ignore,
      }),
      `member ${name}`,
    );
    return handle;
  }

  /** A declared member without a pin: the state `spec check` reports as `NO_SPEC_CONFIG`. */
  unpinned(name: string, files: Record<string, string> = {}): MemberHandle {
    const handle = this.repository(name, files);
    const planned = unwrap(planDeclare(this.dir, name), `declare ${name}`);
    applyInit(planned.plan, [name]);
    return handle;
  }
}
