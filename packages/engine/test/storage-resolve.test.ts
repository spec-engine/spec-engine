// packages/engine/test/storage-resolve.test.ts
//
// Plan 05-01 / Task 1 — lock RSLV-01 + RSLV-02 at the storage seam. The
// `resolveByFiles` method (storage/sqlite.ts) is the single SQL+TS surface
// every higher-level member (plan 05-02's `spec resolve` command, plan
// 05-03's `/api/resolve` HTTP route) reads through. If a future refactor
// breaks the `tags ⨝ requirements` join, drops DISTINCT, or stops sorting
// deterministically by (key, seq), this file fails before any rendered
// output churns.
//
// The headline test is the canonical RSLV-01 trace:
//   resolveByFiles(["api/src/renew.ts", "api/src/charge.ts"])
//     => requirements containing BILLING-009 and BILLING-002.
// That's the moment the `spec resolve` value proposition earns its keep
// at the storage layer — every plan above (CLI, HTTP) is pure surface
// composition over this contract.
//
// Pattern mirrors fts.test.ts: a tmp dbPath per suite, openStorage +
// runIndex against the canonical fixture, then read via
// storage.resolveByFiles(...). WR-06: cloneFixture per test invocation so
// fixtures/platform-fixture/ stays clean.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Storage } from "@spec-engine/shared";
import { runIndex } from "../src/indexer/pipeline";
import { openStorage } from "../src/storage/sqlite";
import { cloneFixture } from "./fixtures/cloneFixture";

const FIXTURE = resolve(import.meta.dir, "..", "..", "..", "fixtures", "platform-fixture");

let clone: string;
let storage: Storage;

beforeAll(async () => {
  clone = cloneFixture(FIXTURE);
  storage = openStorage(join(clone, ".spec-engine", "index.sqlite"));
  await runIndex({ platformDir: clone, storage });
});

afterAll(() => {
  storage.close();
  rmSync(clone, { recursive: true, force: true });
});

describe("storage.resolveByFiles against canonical platform-fixture", () => {
  test("RSLV-01 acceptance: ['api/src/renew.ts', 'api/src/charge.ts'] returns BILLING-009 + BILLING-002", () => {
    // The canonical RSLV-01 trace. `api/src/renew.ts` carries `@spec
    // BILLING-009`, `api/src/charge.ts` carries a BILLING-002 tag. The
    // join MUST surface both requirements, identified by id.
    const rows = storage.resolveByFiles(["api/src/renew.ts", "api/src/charge.ts"]);
    const ids = rows.map((r) => r.id).sort();
    expect(ids).toEqual(["BILLING-002", "BILLING-009"]);
  });

  test("empty input returns [] without touching the DB", () => {
    // The short-circuit branch — no SQL parse cost on the empty path, and
    // no throw. `toEqual([])` is strict-equal on an empty array.
    expect(storage.resolveByFiles([])).toEqual([]);
  });

  test("DISTINCT collapse: same requirement tagged via both implements and verifies → ONE row", () => {
    // Tag kind is path-based (scanner/tags.ts:81 — src/ → implements,
    // test/ → verifies). `api/src/renew.ts` produces an `implements` tag
    // for BILLING-009; `api/test/renew.e2e.test.ts` produces a `verifies`
    // tag for the same BILLING-009. Passing BOTH files in one query would
    // produce two join rows without DISTINCT — the SELECT must collapse
    // them to a single Requirement row keyed by id.
    const rows = storage.resolveByFiles(["api/src/renew.ts", "api/test/renew.e2e.test.ts"]);
    const billing009Rows = rows.filter((r) => r.id === "BILLING-009");
    expect(billing009Rows.length).toBe(1);
  });

  test("deterministic ordering: results sorted by (key, seq) ascending", () => {
    // Same set as Test 1, but assert ORDER not just membership. BILLING-002
    // (seq=2) must precede BILLING-009 (seq=9) — the SQL ORDER BY r.key,
    // r.seq gives this without caller cooperation. Critical for snapshot
    // tests downstream (plan 05-02's formatter) and for any UI that
    // doesn't re-sort.
    const rows = storage.resolveByFiles(["api/src/renew.ts", "api/src/charge.ts"]);
    const ids = rows.map((r) => r.id);
    expect(ids).toEqual(["BILLING-002", "BILLING-009"]);
  });

  test("unknown file returns []", () => {
    // A path with no tag pointing at any requirement → empty result, not
    // throw. The `WHERE t.file IN (...)` clause naturally yields zero
    // joined rows; the storage seam surfaces that as `[]`.
    expect(storage.resolveByFiles(["api/src/no-such-file.ts"])).toEqual([]);
  });

  test("RED-18 multi-repo guard: un-prefixed 'src/renew.ts' still returns [] (no expansion leak)", () => {
    // In multi-repo mode there is NO self-member, so the rung-1 path
    // expansion must never fire — `src/renew.ts` without its `api/` repo
    // prefix matches nothing, exactly as before. This is the regression
    // guard for acceptance criterion 4 (multi-repo resolve unchanged).
    expect(storage.resolveByFiles(["src/renew.ts"])).toEqual([]);
  });
});

// --- RED-18: self-member (rung-1) path expansion ---------------------------
//
// In rung-1 mode the indexer stores tag files as `<repo-basename>/<rel>`
// (e.g. `single-repo-fixture/src/orders.ts`) — the same shape as multi-repo
// members. But the natural user input from the platform root is the
// platform-relative `src/orders.ts`, which previously hit the IN-clause
// verbatim and silently returned []. The storage seam must accept BOTH
// forms in rung-1 mode (decision per acceptance criterion 2: the prefixed
// form keeps working), while multi-repo behavior stays byte-identical.
//
// Pattern mirrors single-repo.test.ts: index the COMMITTED
// fixtures/single-repo-fixture/ (read-only at the platform layer) with the
// DB written to a per-suite tmpdir file so the canonical fixture tree is
// never mutated.
describe("storage.resolveByFiles in self-member (rung-1) mode", () => {
  const SINGLE_REPO_FIXTURE = resolve(
    import.meta.dir,
    "..",
    "..",
    "..",
    "fixtures",
    "single-repo-fixture",
  );

  let tmp: string;
  let rung1: Storage;

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "spec-resolve-rung1-"));
    rung1 = openStorage(join(tmp, "index.sqlite"));
    await runIndex({ platformDir: SINGLE_REPO_FIXTURE, storage: rung1 });
  });

  afterAll(() => {
    rung1.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  test("natural platform-relative path 'src/orders.ts' resolves ORDERS-001 + ORDERS-002", () => {
    // The RED-18 repro: this returned [] (silent miss) because tags are
    // stored as `single-repo-fixture/src/orders.ts`.
    const ids = rung1.resolveByFiles(["src/orders.ts"]).map((r) => r.id);
    expect(ids).toEqual(["ORDERS-001", "ORDERS-002"]);
  });

  test("basename-prefixed form 'single-repo-fixture/src/orders.ts' keeps working", () => {
    const ids = rung1.resolveByFiles(["single-repo-fixture/src/orders.ts"]).map((r) => r.id);
    expect(ids).toEqual(["ORDERS-001", "ORDERS-002"]);
  });

  test("both forms in one call collapse via DISTINCT (no duplicate rows)", () => {
    const ids = rung1
      .resolveByFiles(["src/orders.ts", "single-repo-fixture/src/orders.ts"])
      .map((r) => r.id);
    expect(ids).toEqual(["ORDERS-001", "ORDERS-002"]);
  });

  test("natural test path 'test/orders.test.ts' resolves the verifies tag (ORDERS-001)", () => {
    const ids = rung1.resolveByFiles(["test/orders.test.ts"]).map((r) => r.id);
    expect(ids).toEqual(["ORDERS-001"]);
  });

  test("unknown natural path still returns []", () => {
    expect(rung1.resolveByFiles(["src/no-such-file.ts"])).toEqual([]);
  });
});
