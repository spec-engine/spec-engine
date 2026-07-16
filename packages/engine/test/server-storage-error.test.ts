// packages/engine/test/server-storage-error.test.ts
//
// Webapp hardening follow-up — lock the operational-storage-failure seam end
// to end. Motivating incident: `spec serve` run inside a coding-agent sandbox
// (macOS seatbelt) cannot take the WAL file locks, so every storage call
// throws SQLITE_IOERR_VNODE; the failure used to surface as Hono's bare-text
// 500 and then the SSR pages' "SyntaxError: Failed to parse JSON" — two
// layers of noise burying the actual cause. Now:
//
//   1. storage/errors.ts classifies operational SQLite failures (and ONLY
//      those — our own SQL bugs keep propagating).
//   2. The /api/* middleware translates them to a structured 503
//      `{error: "storage_unavailable", code, hint}`.
//   3. The webapp error boundary renders the hint as a readable error page.
//
// Storage stub: a Proxy whose every method throws a SQLiteError-shaped
// error (structural `code` — the classifier deliberately does not
// instanceof bun:sqlite's class, see D-08 note in storage/errors.ts).

import { describe, expect, test } from "bun:test";
import type { Storage } from "@spec-engine/shared";
import { Hono } from "hono";
import { composeServeApp } from "../src/commands/serve";
import { mountApi } from "../src/server/api";
import { describeStorageError } from "../src/storage/errors";

/** A Storage whose every method throws `err` (path/close behave). */
function throwingStorage(err: Error): Storage {
  return new Proxy({} as Storage, {
    get: (_target, prop) => {
      if (prop === "path") return "/tmp/does-not-exist/index.sqlite";
      if (prop === "close") return () => {};
      return () => {
        throw err;
      };
    },
  });
}

/** SQLiteError-shaped: bun:sqlite errors carry a `code` result-code string. */
function sqliteErr(code: string): Error {
  return Object.assign(new Error("disk I/O error"), { code });
}

describe("describeStorageError (storage/errors.ts classifier)", () => {
  test("SQLITE_IOERR_VNODE → lock/sandbox hint", () => {
    const info = describeStorageError(sqliteErr("SQLITE_IOERR_VNODE"));
    expect(info?.code).toBe("SQLITE_IOERR_VNODE");
    expect(info?.hint).toContain("sandbox");
  });

  test("SQLITE_CANTOPEN + SQLITE_READONLY_DBMOVED also map to the lock hint", () => {
    expect(describeStorageError(sqliteErr("SQLITE_CANTOPEN"))?.hint).toContain("sandbox");
    expect(describeStorageError(sqliteErr("SQLITE_READONLY_DBMOVED"))?.hint).toContain("sandbox");
  });

  test("SQLITE_BUSY → contention hint naming the concurrent-process cause", () => {
    const info = describeStorageError(sqliteErr("SQLITE_BUSY"));
    expect(info?.hint).toContain("another spec process");
  });

  test("SQLITE_CORRUPT → rebuildable-cache hint (delete + re-run)", () => {
    const info = describeStorageError(sqliteErr("SQLITE_CORRUPT"));
    expect(info?.hint).toContain("delete");
  });

  test("plain SQLITE_ERROR (our SQL bug) → null, keeps propagating", () => {
    expect(describeStorageError(sqliteErr("SQLITE_ERROR"))).toBeNull();
  });

  test("non-SQLite values → null", () => {
    expect(describeStorageError(new Error("nope"))).toBeNull();
    expect(describeStorageError(null)).toBeNull();
    expect(describeStorageError({ code: 14 })).toBeNull();
  });
});

describe("/api/* storage backstop (server/api.ts middleware)", () => {
  test("operational SQLite failure → structured 503 storage_unavailable", async () => {
    const app = new Hono();
    mountApi(app, throwingStorage(sqliteErr("SQLITE_IOERR_VNODE")));
    const res = await app.request("/api/coverage");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; code: string; hint: string };
    expect(body.error).toBe("storage_unavailable");
    expect(body.code).toBe("SQLITE_IOERR_VNODE");
    expect(body.hint).toContain("sandbox");
  });

  test("503 still carries Cache-Control: no-store (WR-06 header-before-next)", async () => {
    const app = new Hono();
    mountApi(app, throwingStorage(sqliteErr("SQLITE_BUSY")));
    const res = await app.request("/api/requirements");
    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  test("non-storage error re-throws — stays a 500, never storage_unavailable", async () => {
    const app = new Hono();
    mountApi(app, throwingStorage(new Error("some engine bug")));
    const res = await app.request("/api/coverage");
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("storage_unavailable");
  });
});

describe("SSR error boundary (composed serve app)", () => {
  test("GET / with unavailable storage → 503 error page carrying the hint", async () => {
    const app = composeServeApp(throwingStorage(sqliteErr("SQLITE_IOERR_VNODE")));
    const res = await app.request("/");
    expect(res.status).toBe(503);
    const body = await res.text();
    // The page surfaces the engine's structured cause + hint...
    expect(body).toContain("storage_unavailable");
    expect(body).toContain("sandbox");
    // ...instead of the old downstream JSON-parse crash.
    expect(body).not.toContain("Failed to parse JSON");
  });

  test("GET /requirements with unavailable storage → same readable error page", async () => {
    const app = composeServeApp(throwingStorage(sqliteErr("SQLITE_BUSY")));
    const res = await app.request("/requirements");
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("another spec process");
  });

  test("non-storage page failure → generic 500 page, no internals leaked", async () => {
    const app = composeServeApp(throwingStorage(new Error("secret internal detail")));
    const res = await app.request("/");
    expect(res.status).toBe(500);
    const body = await res.text();
    // The /api boundary collapses the unknown error to "internal error"; the
    // page renders that — and NEVER the thrown message itself (T-5-03-03).
    expect(body).toContain("internal error");
    expect(body).not.toContain("secret internal detail");
  });
});
