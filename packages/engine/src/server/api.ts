// packages/engine/src/server/api.ts
//
// Plan 05-03 / Task 2 — the engine-side `/api/*` Hono route module. Read
// routes are thin handlers over the shared `Storage` interface: validate
// query/param → call storage → c.json(rows). The webapp consumes these
// routes via `app.request()` (Pitfall 6, in-process — no double
// serialization, no port bind).
//
// Plan 21-01 / VAL-03: this module now also mounts the FIRST state-changing
// routes — `POST /api/requirements` (create) and `PUT /api/requirements/:id`
// (amend). They are NOT CSRF-inert; each is defended by (a) an Origin/Host
// same-origin check (T-21-01 — a cross-origin browser POST is rejected 403;
// the in-process `app.request` forward sends no Origin and is allowed), (b) a
// required `application/json` content-type, and (c) a Content-Length / body
// body-size cap (T-21-04). Every write goes through the SINGLE
// `validateAndWrite()` seam in @spec-engine/shared (VAL-01 — never a bespoke
// Bun.write of a spec path) and re-derives the index via `runIndex`
// (cold-build invariant). The spec path is derived ONLY from the enumerated
// safe domain key (listDomainKeys + normalizeDomainKey), never from raw input
// (T-21-02).
//
// SERV-01 + SERV-03 land here. Plan 05-04 mounts SSR pages onto the same
// Hono app; plan 05-05 composes the whole thing in `commands/serve.ts`.
//
// D-08 grep-fence: this file does NOT import bun:sqlite. DB access goes
// exclusively through the Storage interface from @spec-engine/shared. CI greps
// the bun:sqlite import statement across packages/engine/src and asserts
// exactly one match (storage/sqlite.ts). server/* must stay clean — note
// this comment intentionally avoids the literal import-statement pattern
// so the grep-fence regex (`from\s+"bun:sqlite"`) stays single-line.
//
// Pitfall 6 (RESEARCH): SSR pages call these routes via Hono's
// `app.request(path)` — same handler logic as tests, no Bun.serve loopback
// round-trip. Document this for plan 05-04 maintainers: do NOT replace
// with `fetch('http://127.0.0.1:port/api/...')` — that's a double-serialize
// loop within the same binary.
//
// Pitfall 8 (RESEARCH): FTS5 grammar errors must NEVER leak SQLite
// internals or unhandled 500s. The typed prefix `searchFts: FTS5 query
// syntax error` (raised by storage.searchFts in sqlite.ts:457) is caught
// and translated to a friendly 400 — defense against information disclosure
// (T-5-03-03) and a usable client-side error shape.

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  buildCoverageReport,
  DEFAULT_QUERY_LIMIT,
  FILES_MAX,
  ID_RE,
  isLoopbackHostname,
  LIMIT_MAX,
  REQUIREMENT_STATUSES,
  type RequirementStatus,
  type Storage,
  validateAndWrite,
} from "@spec-engine/shared";
import type { Context, Hono } from "hono";
import { listDomainKeys, nextRequirementId, normalizeDomainKey } from "../authoring/domains";
import { localToday } from "../authoring/edit";
import { derivePlatformVersion } from "../indexer/discover";
import { runIndex } from "../indexer/pipeline";
import { renderProvenanceDecorated } from "../provenance/format";
import { resolveAndCache } from "../provenance/resolve";
import { renderRelations, sortRelations } from "../relations/format";
import { sortReqTags } from "../resolve/format";
import { describeStorageError } from "../storage/errors";

/**
 * Strict positive-integer shape from commands/query.ts:86-101 — mirrors
 * the CLI's WR-04 limit validation so the HTTP and CLI surfaces share a
 * single contract on `--limit` / `?limit=`. `Number.parseInt` is too
 * permissive (`"10abc"` → 10); this regex is the load-bearing check.
 */
const POSITIVE_INT_RE = /^[1-9][0-9]*$/;

// LIMIT_MAX / DEFAULT_QUERY_LIMIT (the `?limit=` ceiling + default, shared with
// the CLI and MCP front-ends) are imported from @spec-engine/shared.
// FILES_MAX (WR-02 iter1 / WR-01 iter3) is imported from @spec-engine/shared so
// the CLI seam (commands/resolve.ts), HTTP seam (this file), and storage
// seam (storage/sqlite.ts resolveByFiles defense-in-depth check) share a
// single constant. A future bump only touches @spec-engine/shared.

/**
 * Path-shape predicate for `/api/resolve` (WR-05). A traversal hazard is
 * `..` as a path SEGMENT (separated by `/` OR `\`), not as a substring.
 * Substring checks over-reject legitimate file names like
 * `my..thing/file.ts` or `version..1.2.ts`. Mirrored by the storage seam's
 * platform-relative invariant (T-5-03-02).
 *
 * WR-02 (iter2): also split on `\` so Windows-style traversal segments
 * (`..\..\etc\passwd`) are caught alongside POSIX (`../../etc/passwd`).
 * CI runs darwin-arm64 but the storage seam compares tag paths byte-for-byte,
 * so the cross-platform inconsistency would otherwise let a Windows caller
 * silently get `[]` instead of a clean 400.
 */
function hasTraversalSegment(p: string): boolean {
  return p.split(/[/\\]/).some((seg) => seg === "..");
}

/**
 * WR-02 (iter2) cross-platform absolute-path predicate. The previous
 * `f.startsWith("/")` check only blocked POSIX absolutes; Windows callers
 * could submit `C:\Windows\...` or a UNC-style `\\server\share` and pass
 * the shape guard (then silently no-match the storage seam). Reject:
 *   - leading `/` (POSIX absolute)
 *   - leading `\` (Windows root-relative or UNC prefix)
 *   - drive-letter prefixes like `C:\foo` or `C:/foo`
 */
function hasAbsoluteShape(p: string): boolean {
  return p.startsWith("/") || p.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(p);
}

/**
 * `/api/resolve?req=KEY-NNN` — the reverse of the files→requirements resolve,
 * mirroring the CLI's `spec resolve --req` (T8). Emits the ReqTagRow shape
 * `{ req_id, repo, file, line, kind, level }` (Tag minus the AUTOINCREMENT id),
 * sorted through the SAME `sortReqTags` the CLI renders through so the HTTP and
 * CLI surfaces are byte-identical. An unknown id is `[]` + 200 (not 404) — same
 * as the CLI, which exits 0 with `[]`. `req` and `files` are mutually exclusive.
 */
function resolveByReq(c: Context, storage: Storage, reqParam: string): Response {
  if ((c.req.queries("files") ?? []).length > 0) {
    return c.json({ error: "pass either req or files, not both" }, 400);
  }
  if (!ID_RE.test(reqParam)) {
    return c.json({ error: "req must be a requirement id (KEY-NNN)" }, 400);
  }
  const rows = storage
    .listTags({ req_id: reqParam })
    .map(({ req_id, repo, file, line, kind, level }) => ({
      req_id,
      repo,
      file,
      line,
      kind: kind as string,
      level: (level ?? null) as string | null,
    }));
  return c.json(sortReqTags(rows));
}

/**
 * Storage backstop: wrap a route handler so an OPERATIONAL SQLite failure
 * (locks denied under a sandbox, cross-process SQLITE_BUSY, corrupt cache —
 * see storage/errors.ts) becomes a structured 503 `{error:
 * "storage_unavailable", code, hint}` instead of Hono's bare-text 500. Two
 * audiences: the SSR pages surface the hint as a readable error page rather
 * than choking on a non-JSON body, and agents driving the API get a named
 * cause they can act on. Anything the classifier does NOT recognize (our own
 * SQL bugs, plain Errors) re-throws unchanged — Pitfall 8, never silently
 * swallow.
 *
 * This is a per-HANDLER wrapper, not a `try { await next() }` middleware,
 * because Hono's compose catches a thrown handler at the innermost dispatch
 * level and hands it straight to the app-global `onError` — upstream
 * middleware never sees it. And it is not an `app.onError` because that is a
 * single app-wide slot the webapp's SSR error boundary also needs (last
 * registration would silently win — see webapp pages/data.ts).
 */
function guarded<C extends Context>(
  handler: (c: C) => Response | Promise<Response>,
): (c: C) => Promise<Response> {
  return async (c: C): Promise<Response> => {
    try {
      return await handler(c);
    } catch (err) {
      const info = describeStorageError(err);
      if (info === null) throw err;
      console.error(`spec serve: /api storage unavailable (${info.code}):`, err);
      return c.json({ error: "storage_unavailable", code: info.code, hint: info.hint }, 503);
    }
  };
}

/**
 * The typed prefix `storage.searchFts` raises on FTS5 grammar errors
 * (sqlite.ts:457 — `searchFts: FTS5 query syntax error for ...`).
 * Operational errors (locked, OOM, disk I/O) DO NOT carry this prefix and
 * pass through unchanged — they surface as 500s so callers know it's not
 * a syntax problem. Pitfall 8 — never silently swallow.
 */
const FTS_SYNTAX_ERROR_PREFIX = "searchFts: FTS5 query syntax error";

/**
 * VAL-03 / T-21-04: upper bound on a write request body. A requirement
 * statement + why is a few hundred bytes; 64 KiB is generous headroom while
 * still rejecting a DoS-scale payload BEFORE it is parsed. Enforced against
 * both the `Content-Length` header (fast reject) and the actual read length
 * (defense-in-depth against a missing/lying header).
 */
const MAX_WRITE_BODY_BYTES = 64 * 1024;

/**
 * 2.6: in-process write serialization. `POST /api/requirements` does
 * read → compute-next-id → write → reindex with no locking, so two concurrent
 * POSTs could both read the same max seq and mint the SAME id. A single local
 * server needs nothing heavier than a promise chain: each write awaits the
 * previous one's completion. `.then(fn, fn)` runs `fn` whether the prior link
 * resolved OR rejected (a failed write must not wedge the chain); the stored
 * link swallows errors so an unhandled rejection never escapes.
 */
let writeChain: Promise<unknown> = Promise.resolve();
function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.catch(() => {});
  return run;
}

/**
 * T-21-01 same-origin guard for the state-changing routes, plus a
 * DNS-rebinding Host pin (1.1). Two independent checks:
 *
 * 1. Host pin (unconditional): the server only ever binds 127.0.0.1
 *    (commands/serve.ts), so a write whose own Host is not a loopback name did
 *    not come from a page we served — it is a rebind (attacker DNS →
 *    127.0.0.1, `Host: evil.example`). The Origin/Host same-origin check below
 *    cannot catch this because both headers are attacker-controlled and AGREE.
 *    The in-process `app.request()` forward synthesizes `http://localhost/…`,
 *    so it passes.
 * 2. Same-origin (only when an `Origin` header is present): its host MUST
 *    equal the request's own host. A cross-site browser form post carries a
 *    mismatched Origin and is rejected 403. The in-process forward sends NO
 *    Origin header, so it passes untouched.
 *
 * Returns a 403 Response on rejection, or `null` to proceed.
 */
function rejectCrossOrigin(c: Context): Response | null {
  const selfUrl = new URL(c.req.url);
  if (!isLoopbackHostname(selfUrl.hostname)) {
    return c.json({ error: "cross-origin request rejected" }, 403);
  }
  const origin = c.req.header("origin");
  if (origin === undefined) return null;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return c.json({ error: "cross-origin request rejected" }, 403);
  }
  if (originHost !== selfUrl.host) {
    return c.json({ error: "cross-origin request rejected" }, 403);
  }
  return null;
}

/**
 * Shared header preflight for POST/PUT: require `application/json` and reject
 * an over-cap `Content-Length` (T-21-04) before the body is read. Returns a
 * rejection Response, or `null` to proceed.
 */
function rejectBadWriteHeaders(c: Context): Response | null {
  const ct = c.req.header("content-type") ?? "";
  if (!ct.toLowerCase().includes("application/json")) {
    return c.json({ error: "content-type must be application/json" }, 415);
  }
  const clen = c.req.header("content-length");
  if (clen !== undefined && Number(clen) > MAX_WRITE_BODY_BYTES) {
    return c.json({ error: "request body too large" }, 413);
  }
  return null;
}

/**
 * Read + JSON-parse a write body with the body-size cap enforced on the actual
 * bytes (defense-in-depth beyond the Content-Length check). Returns the parsed
 * object, or a rejection Response (413 over-cap, 400 non-object / bad JSON).
 */
async function readJsonBody(
  c: Context,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; res: Response }> {
  let raw: string;
  try {
    raw = await c.req.text();
  } catch {
    return { ok: false, res: c.json({ error: "invalid request body" }, 400) };
  }
  // WR-02: cap on BYTE length, not UTF-16 code units — a multibyte payload
  // (e.g. emoji / CJK) must not slip past a 64 KiB ceiling measured in `.length`.
  if (Buffer.byteLength(raw, "utf8") > MAX_WRITE_BODY_BYTES) {
    return { ok: false, res: c.json({ error: "request body too large" }, 413) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, res: c.json({ error: "invalid JSON body" }, 400) };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, res: c.json({ error: "body must be a JSON object" }, 400) };
  }
  return { ok: true, body: parsed as Record<string, unknown> };
}

/**
 * Normalize the optional `livesIn` write field to the STOR-01 `string[]` shape:
 * a string becomes a single-element array, an array passes through, anything
 * else (or absent) becomes `[]`. Mirrors the `req.ts` / `amend.ts` recipe.
 */
function toLivesIn(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  if (typeof v === "string" && v.length > 0) return [v];
  return [];
}

/**
 * Resolve the target domain's SPEC path from a create request body.
 *
 * T-21-02: the spec path is derived ONLY from the enumerated safe key —
 * normalizeDomainKey + membership in listDomainKeys(platformDir) — never
 * from raw user input joined onto the filesystem. Returns the resolved
 * `{ key, relFile, specPath }`, or the 400 (unknown key) / 404 (missing
 * domain file) rejection Response.
 */
function resolveCreateTarget(
  c: Context,
  platformDir: string,
  body: Record<string, unknown>,
): { ok: true; key: string; relFile: string; specPath: string } | { ok: false; res: Response } {
  const rawKey = typeof body.key === "string" ? body.key : "";
  const key = normalizeDomainKey(rawKey);
  if (key === "" || !listDomainKeys(platformDir).includes(key)) {
    return { ok: false, res: c.json({ error: "unknown domain key" }, 400) };
  }
  const relFile = `spec-engine/${key}/SPEC.json`;
  const specPath = join(platformDir, "spec-engine", key, "SPEC.json");
  if (!existsSync(specPath)) return { ok: false, res: c.json({ error: "not found" }, 404) };
  return { ok: true, key, relFile, specPath };
}

/**
 * Build a new requirement record EXACTLY as commands/req.ts:303-314 does
 * (status "active", why||null, supersedes/supersededBy null, empty
 * relates/issues, changedAtVersion 1) so the CLI and webapp author
 * byte-identical envelopes. `statement`/`why` pass through raw so an
 * empty/whitespace statement reaches validateDomainFile and is rejected
 * there (VAL-02) rather than by a forked check here.
 */
function buildRequirement(body: Record<string, unknown>, id: string): Record<string, unknown> {
  return {
    id,
    status: "active",
    statement: body.statement,
    why: body.why ?? null,
    supersedes: null,
    supersededBy: null,
    relates: [],
    livesIn: toLivesIn(body.livesIn),
    issues: [],
  };
}

/**
 * Locate requirement `id` by scanning the enumerated domain keys for the one
 * whose SPEC.json actually contains it.
 *
 * T-21-02: the domain is resolved by scanning listDomainKeys(platformDir) and
 * JSON.parsing each SPEC.json — never a client-supplied path.
 *
 * 2.6: a malformed SPEC.json is reported as `{ kind: "invalid", relFile }`
 * rather than throwing a raw SyntaxError — the PUT handler maps it to the
 * structured `INVALID_DOMAIN_FILE` 400 used elsewhere, not an opaque 500.
 * `kind: "found"` carries the record; `kind: "not_found"` maps to 404.
 */
type LocateResult =
  | {
      kind: "found";
      specPath: string;
      relFile: string;
      domain: Record<string, unknown>;
      req: Record<string, unknown>;
    }
  | { kind: "not_found" }
  | { kind: "invalid"; relFile: string };

async function locateRequirement(platformDir: string, id: string): Promise<LocateResult> {
  for (const key of listDomainKeys(platformDir)) {
    const specPath = join(platformDir, "spec-engine", key, "SPEC.json");
    const relFile = `spec-engine/${key}/SPEC.json`;
    let domain: Record<string, unknown>;
    try {
      domain = JSON.parse(await Bun.file(specPath).text()) as Record<string, unknown>;
    } catch {
      return { kind: "invalid", relFile };
    }
    const reqs = Array.isArray(domain.requirements) ? domain.requirements : [];
    const req = reqs.find(
      (r): r is Record<string, unknown> =>
        typeof r === "object" && r !== null && (r as { id?: unknown }).id === id,
    );
    if (req) {
      return { kind: "found", specPath, relFile, domain, req };
    }
  }
  return { kind: "not_found" };
}

/**
 * Apply only the provided amend fields to `req` (amend.ts semantics — untouched
 * fields stay byte-identical). `statement` passes through raw so an empty value
 * is rejected by validateDomainFile (VAL-02); `why` collapses an absent value
 * to null; `livesIn` is normalized. Returns whether ANY field was applied so
 * the handler can emit the "nothing to amend" 400.
 */
function applyAmendFields(req: Record<string, unknown>, body: Record<string, unknown>): boolean {
  const hasStatement = typeof body.statement === "string";
  const hasWhy = "why" in body;
  const hasLives = "livesIn" in body;
  if (!hasStatement && !hasWhy && !hasLives) return false;
  if (hasStatement) req.statement = body.statement;
  if (hasWhy) req.why = body.why ?? null;
  if (hasLives) req.livesIn = toLivesIn(body.livesIn);
  return true;
}

/**
 * Parse + validate the `/api/query` `?limit=` value. The strict POSITIVE_INT_RE
 * shape check AND the LIMIT_MAX ceiling both emit the SAME
 * `limit must be a positive integer ≤ LIMIT_MAX` 400 they do inline today.
 * Returns the parsed integer, or the 400 rejection Response.
 */
function parseQueryLimit(
  c: Context,
  rawLimit: string,
): { ok: true; limit: number } | { ok: false; res: Response } {
  if (!POSITIVE_INT_RE.test(rawLimit)) {
    return {
      ok: false,
      res: c.json({ error: `limit must be a positive integer ≤ ${LIMIT_MAX}` }, 400),
    };
  }
  const limit = Number.parseInt(rawLimit, 10);
  if (limit > LIMIT_MAX) {
    return {
      ok: false,
      res: c.json({ error: `limit must be a positive integer ≤ ${LIMIT_MAX}` }, 400),
    };
  }
  return { ok: true, limit };
}

/**
 * Mount the read-only `/api/*` plane onto an existing Hono app and return
 * the same app for chainability. Seven GET routes, no state-changing
 * endpoints (T-5-03-05).
 *
 * `Cache-Control: no-store` middleware fires for every `/api/*` path so
 * browsers (and intermediaries) never cache a derived-index response
 * across reindexes — defensive against the "I ran spec index but the
 * webapp still shows stale rows" footgun. Registered BEFORE the route
 * handlers so it applies uniformly (RESEARCH Open Q5).
 *
 * V12 path-shape guard for `/api/resolve?files=`: the route does NOT have
 * access to `platformDir` (it only sees the Storage handle), so V12
 * path-containment is enforced at the CLI layer (commands/resolve.ts).
 * Here we enforce SHAPE — reject any file containing `..` or starting
 * with `/` — as defense-in-depth alongside the storage seam's
 * platform-relative invariant (T-5-03-02).
 *
 * Phase 16 (PWEB-01): `platformDir` is an OPTIONAL third param (default
 * `process.cwd()` so the existing 2-arg callers/tests are unchanged). It is
 * threaded ONLY into the `/api/provenance?resolve=1` decorated-text seam,
 * where `resolveAndCache` writes its tracker sidecar under
 * `<platformDir>/.spec-engine/`. The real-serve composer (`composeServeApp` in
 * commands/serve.ts) passes the resolved platformDir through; tests pass the
 * fixture clone. Resolution is engine-SIDE — the webapp reads the decorated
 * text and never imports `@spec-engine/tracker` (D-09).
 *
 * @spec SERV-002
 */
export function mountApi(app: Hono, storage: Storage, platformDir: string = process.cwd()): Hono {
  // No-store middleware — applies to every `/api/*` route below. Registered
  // before the handlers so the header is set even on 400/404 responses.
  //
  // WR-06: set the header BEFORE next() so it survives a thrown handler
  // (e.g. /api/query re-throwing a non-FTS5 error, or a prepared SELECT
  // throwing on a corrupted DB). Hono's default error handler emits a 500
  // — headers set before next() land on the eventual response regardless
  // of who produces the body. The previous "after next()" placement meant
  // the line was unreachable on throw, so 500s went out without no-store.
  //
  app.use("/api/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });

  // --- /api/coverage ------------------------------------------------------

  app.get(
    "/api/coverage",
    guarded((c) => c.json(storage.coverageMatrix())),
  );

  // --- /api/repos ---------------------------------------------------------
  // The registered member repos (name, path, pinned spec version) — read-only,
  // straight off the derived DB. Backs the webapp Setup page's mapped-repos
  // view. Discovery-only hints (selfMember/ignore) are absent from stored rows.

  app.get(
    "/api/repos",
    guarded((c) => c.json(storage.listRepos())),
  );

  // --- /api/platform ------------------------------------------------------
  // The platform version — DERIVED at request time as the max of the domains'
  // DAG-derived versions (RED-85; the authored spec-engine.platform.json
  // manifest is retired). Backs the Setup page's version row.

  app.get("/api/platform", async (c) => {
    const version = await derivePlatformVersion(platformDir);
    return c.json({ version, source: "derived" });
  });

  // --- /api/report ----------------------------------------------------------
  // W1: per-domain rollup over Active requirements — the shared
  // buildCoverageReport over the SAME coverage VIEW /api/coverage serves,
  // so the report can never disagree with the matrix.

  app.get(
    "/api/report",
    guarded((c) => c.json(buildCoverageReport(storage.coverageMatrix()))),
  );

  // --- /api/requirements --------------------------------------------------

  app.get(
    "/api/requirements",
    guarded((c) => {
      const key = c.req.query("key");
      const statusRaw = c.req.query("status");

      if (
        statusRaw !== undefined &&
        !REQUIREMENT_STATUSES.includes(statusRaw as RequirementStatus)
      ) {
        return c.json({ error: `status must be one of ${REQUIREMENT_STATUSES.join("|")}` }, 400);
      }

      const status = statusRaw as RequirementStatus | undefined;
      return c.json(storage.listRequirements({ key, status }));
    }),
  );

  app.get(
    "/api/requirements/:id",
    guarded((c) => {
      const id = c.req.param("id") ?? "";
      const row = storage.getRequirement(id);
      return row ? c.json(row) : c.json({ error: "not found" }, 404);
    }),
  );

  // --- POST /api/requirements (VAL-03 create) ----------------------------
  //
  // Create a requirement in the target domain's SPEC.json through the SINGLE
  // `validateAndWrite` seam, then re-derive the index. The requirement object
  // is built EXACTLY as commands/req.ts appendEntry does (status "active",
  // why||null, empty relates/issues, changedAtVersion 1) so the CLI and webapp
  // author byte-identical envelopes (one engine). On a structural reject the
  // route returns the SAME diagnostics validateDomainFile emits (VAL-02 — no
  // re-validation, no reshaping).
  app.post(
    "/api/requirements",
    guarded(async function createRequirement(c) {
      const originReject = rejectCrossOrigin(c);
      if (originReject) return originReject;
      const headerReject = rejectBadWriteHeaders(c);
      if (headerReject) return headerReject;
      const parsed = await readJsonBody(c);
      if (!parsed.ok) return parsed.res;
      const body = parsed.body;

      const target = resolveCreateTarget(c, platformDir, body);
      if (!target.ok) return target.res;

      // 2.6: serialize the read→next-id→write→reindex critical section so two
      // concurrent POSTs can never read the same max seq and mint the same id.
      return withWriteLock(async () => {
        let domain: { requirements?: unknown[]; updated?: string; [k: string]: unknown };
        try {
          domain = JSON.parse(await Bun.file(target.specPath).text());
        } catch {
          return c.json(
            { error: "INVALID_DOMAIN_FILE", detail: `${target.relFile} is not valid JSON` },
            400,
          );
        }
        const requirements = Array.isArray(domain.requirements) ? domain.requirements : [];
        const id = await nextRequirementId(platformDir, target.key);
        requirements.push(buildRequirement(body, id));
        domain.requirements = requirements;
        domain.updated = localToday();

        const res = await validateAndWrite(target.specPath, domain, target.relFile);
        if (!res.ok) {
          // T-21-08: surface ONLY the structured diagnostics — never a raw
          // exception / FS internals. Same object the CLI prints (VAL-02).
          return c.json({ error: "INVALID_DOMAIN_FILE", diagnostics: res.diagnostics }, 400);
        }
        await runIndex({ platformDir, storage });
        return c.json({ ok: true, id }, 201);
      });
    }),
  );

  // --- PUT /api/requirements/:id (VAL-03 amend) --------------------------
  //
  // Amend an existing requirement's statement/why/livesIn through the same
  // seam. The domain is resolved by `locateRequirement` scanning the enumerated
  // domain keys; only the provided fields are mutated (amend.ts semantics),
  // untouched fields stay byte-identical.
  app.put(
    "/api/requirements/:id",
    guarded(async function amendRequirement(c) {
      const originReject = rejectCrossOrigin(c);
      if (originReject) return originReject;
      const headerReject = rejectBadWriteHeaders(c);
      if (headerReject) return headerReject;
      const parsed = await readJsonBody(c);
      if (!parsed.ok) return parsed.res;
      const body = parsed.body;

      const id = c.req.param("id") ?? "";

      // 2.6: serialize with the create path — locate → mutate → write → reindex
      // must not interleave with a concurrent create's next-id read.
      return withWriteLock(async () => {
        const found = await locateRequirement(platformDir, id);
        if (found.kind === "not_found") return c.json({ error: "not found" }, 404);
        if (found.kind === "invalid") {
          // 2.6: a malformed SPEC.json is the structured INVALID_DOMAIN_FILE
          // 400 used elsewhere, never an opaque 500.
          return c.json(
            { error: "INVALID_DOMAIN_FILE", detail: `${found.relFile} is not valid JSON` },
            400,
          );
        }

        if (!applyAmendFields(found.req, body)) {
          return c.json({ error: "nothing to amend — provide statement, why, or livesIn" }, 400);
        }
        found.domain.updated = localToday();

        const res = await validateAndWrite(found.specPath, found.domain, found.relFile);
        if (!res.ok) {
          return c.json({ error: "INVALID_DOMAIN_FILE", diagnostics: res.diagnostics }, 400);
        }
        await runIndex({ platformDir, storage });
        return c.json({ ok: true, id }, 200);
      });
    }),
  );

  // --- /api/propagation/:id ----------------------------------------------

  app.get(
    "/api/propagation/:id",
    guarded((c) => c.json(storage.propagationFor(c.req.param("id") ?? ""))),
  );

  // --- /api/query --------------------------------------------------------

  app.get(
    "/api/query",
    guarded((c) => {
      const q = (c.req.query("q") ?? "").trim();
      if (!q) {
        return c.json({ error: "q is required (non-empty FTS5 MATCH query)" }, 400);
      }

      const rawLimit = c.req.query("limit") ?? String(DEFAULT_QUERY_LIMIT);
      const parsedLimit = parseQueryLimit(c, rawLimit);
      if (!parsedLimit.ok) return parsedLimit.res;

      try {
        return c.json(storage.searchFts(q, parsedLimit.limit));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Translate the typed `searchFts: FTS5 query syntax error` prefix to
        // a sanitized 400. The sanitized message keeps the FTS5 token so the
        // webapp client can surface "wrap phrases in double quotes" hints
        // without leaking the raw SQLite internals (T-5-03-03).
        if (msg.startsWith(FTS_SYNTAX_ERROR_PREFIX)) {
          return c.json({ error: "FTS5 grammar error; wrap phrases in double quotes" }, 400);
        }
        throw e;
      }
    }),
  );

  // --- /api/relations ------------------------------------------------------

  app.get(
    "/api/relations",
    guarded((c) => {
      // RED-17: ?format=mermaid serves the SAME engine formatter the CLI
      // renders through (relations/format.ts) — the webapp /relations page
      // reads this text seam because its import fence (D-09) forbids
      // importing @spec-engine/spec-check directly. Default (no format) is the JSON
      // row projection, consistent with every other /api/* route.
      const format = c.req.query("format");
      if (format !== undefined && format !== "mermaid") {
        return c.json({ error: 'format must be "mermaid" when provided' }, 400);
      }
      const rows = storage.listRelations();
      if (format === "mermaid") {
        return c.text(renderRelations(rows, "mermaid"));
      }
      return c.json(sortRelations(rows));
    }),
  );

  // --- /api/provenance -----------------------------------------------------

  app.get(
    "/api/provenance",
    guarded(async (c) => {
      // PWEB-01: ?resolve=1 serves the SAME shared decorator the CLI
      // `--resolve-issues` flag renders through (provenance/format.ts
      // renderProvenanceDecorated) after resolving issues ENGINE-SIDE via the
      // surface-layer resolveAndCache (provenance/resolve.ts — the only tracker
      // importer besides commands/). The webapp /provenance page reads this text
      // seam because its import fence (D-09) forbids importing @spec-engine/tracker.
      // Default (no resolve) is the JSON matrix projection, consistent with every
      // other /api/* route. This mirrors /api/relations?format=mermaid exactly.
      const resolveParam = c.req.query("resolve");
      if (resolveParam !== undefined && resolveParam !== "1") {
        return c.json({ error: 'resolve must be "1" when provided' }, 400);
      }
      const rows = storage.provenanceMatrix();
      if (resolveParam === "1") {
        // Resolution is engine-side. With no SPEC_TRACKER_TOKEN this degrades to
        // the bare ids + the token hint with NO network call (resolveAndCache is
        // no-throw and the adapter degrades to {ok:false}).
        const resolved = await resolveAndCache(rows, platformDir);
        return c.text(renderProvenanceDecorated(rows, resolved, "text"));
      }
      return c.json(rows);
    }),
  );

  // --- /api/provenance/:issue ---------------------------------------------
  // Bound reverse lookup mirroring /api/propagation/:id. `issue` is a bound
  // param VALUE — passed straight to storage.provenanceByIssue (which binds it
  // as `$issue`), NEVER string-interpolated into SQL and never a routing/
  // resolve/coverage/JOIN key (PROV-02/SC3 opacity).

  app.get(
    "/api/provenance/:issue",
    guarded((c) => c.json(storage.provenanceByIssue(c.req.param("issue") ?? ""))),
  );

  // --- /api/resolve ------------------------------------------------------

  app.get(
    "/api/resolve",
    guarded((c) => {
      // Reverse mode (`?req=KEY-NNN`) mirrors the CLI's `spec resolve --req`
      // (T8): map a requirement to its tag sites instead of files → requirements.
      const reqParam = c.req.query("req");
      if (reqParam !== undefined) return resolveByReq(c, storage, reqParam);

      // Hono's c.req.queries(name) returns an array for repeated query params
      // (`?files=a&files=b` → ["a","b"]). Validated upstream by RESEARCH A3.
      const files = c.req.queries("files") ?? [];

      if (files.length === 0) {
        return c.json({ error: "files query is required (one or more)" }, 400);
      }

      // WR-02: cap the array length so a `?files=…&files=…` of arbitrary
      // size cannot blow past SQLITE_MAX_VARIABLE_NUMBER (32766) downstream
      // in storage.resolveByFiles. 1000 mirrors LIMIT_MAX for /api/query and
      // is more than any real platform-scale call needs. Same cap is
      // enforced at the CLI seam (commands/resolve.ts) so the contract holds
      // at every entry point.
      if (files.length > FILES_MAX) {
        return c.json({ error: `too many files (max ${FILES_MAX} per request)` }, 400);
      }

      // V12 path-shape guard (T-5-03-02): defense-in-depth alongside the
      // CLI's containment check. Rejecting `..` SEGMENTS (not substrings) and
      // leading `/` is sufficient at the HTTP layer because storage stores
      // tag files as platform-relative — an absolute or traversal path can
      // never match a real tag, but rejecting them up front gives the caller
      // a clear error instead of a silent empty result.
      //
      // WR-05: previously this was `f.includes("..")`, which over-rejected
      // legitimate file names like `my..thing/file.ts` or `version..1.2.ts`.
      // The actual traversal hazard is `..` as a path SEGMENT.
      for (const f of files) {
        if (hasTraversalSegment(f) || hasAbsoluteShape(f)) {
          return c.json(
            { error: "files must be platform-relative (no .. segments, no leading /)" },
            400,
          );
        }
      }

      return c.json(storage.resolveByFiles(files));
    }),
  );

  return app;
}
