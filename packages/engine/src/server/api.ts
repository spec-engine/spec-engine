// The engine-side `/api/*` Hono routes. Read routes are thin handlers over the
// Storage handle; the write routes parse and guard the request, then call the
// same operations the CLI calls. The webapp reaches these routes in-process via
// `app.request()`: never replace that with a loopback fetch, which would
// serialize twice inside one binary.
//
// Write routes are defended by an Origin/Host same-origin check, a required
// `application/json` content type, and a body-size cap, and every write goes
// through the operations layer, whose single write seam validates the whole
// envelope.

import {
  DEFAULT_BIND_HOST,
  DEFAULT_QUERY_LIMIT,
  FILES_MAX,
  featureDisabledMessage,
  featureEnabled,
  ID_RE,
  InvalidDomainFilesError,
  isServedHostname,
  LIMIT_MAX,
  type PlatformInfo,
  REQUIREMENT_STATUSES,
  type RequirementStatus,
  type Storage,
} from "@spec-engine/shared";
import type { Context, Hono } from "hono";
import { listDomainKeys, normalizeDomainKey } from "../authoring/domains";
import { sortDiagnostics } from "../check/format";
import { derivePlatformVersion, platformMode, platformName } from "../indexer/discover";
import { runIndex } from "../indexer/pipeline";
import { type OpFailure, STATUS_FOR_REASON } from "../operations/_result";
import { accept } from "../operations/accept";
import { type AmendFields, amend } from "../operations/amend";
import { deprecate } from "../operations/deprecate";
import { mint } from "../operations/mint";
import { move } from "../operations/move";
import {
  coverageMatrix,
  coverageReport,
  propagation,
  provenance,
  query,
  relations,
  reqTags,
} from "../operations/reads";
import { getRecord, listRecords } from "../operations/records";
import { supersede } from "../operations/supersede";
import { renderProvenanceDecorated } from "../provenance/format";
import { resolveAndCache } from "../provenance/resolve";
import { renderRelations, sortRelations } from "../relations/format";
import { sortReqTags } from "../resolve/format";
import { describeStorageError } from "../storage/errors";

/**
 * Strict positive-integer shape, the same contract the CLI applies to
 * `--limit`. `Number.parseInt` is too permissive (`"10abc"` → 10).
 */
const POSITIVE_INT_RE = /^[1-9][0-9]*$/;

/**
 * Path-shape predicate for `/api/resolve`. A traversal hazard is
 * `..` as a path SEGMENT (separated by `/` OR `\`), not as a substring.
 * Substring checks over-reject legitimate file names like
 * `my..thing/file.ts` or `version..1.2.ts`.
 *
 * The storage seam compares tag paths byte-for-byte, so an unsplit `\`
 * would let a Windows caller silently get `[]` instead of a clean 400.
 */
function hasTraversalSegment(p: string): boolean {
  return p.split(/[/\\]/).some((seg) => seg === "..");
}

/**
 * Cross-platform absolute-path predicate: a POSIX-only check would let
 * `C:\Windows\...` or a UNC `\\server\share` pass the shape guard and then
 * silently no-match the storage seam.
 */
function hasAbsoluteShape(p: string): boolean {
  return p.startsWith("/") || p.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(p);
}

/**
 * Sorted through the same `sortReqTags` the CLI renders through so the HTTP and
 * CLI surfaces are byte-identical. An unknown id is `[]` + 200, not 404, to
 * match the CLI's exit-0 `[]`.
 */
function resolveByReq(c: Context, storage: Storage, reqParam: string): Response {
  if ((c.req.queries("files") ?? []).length > 0) {
    return c.json({ error: "pass either req or files, not both" }, 400);
  }
  if (!ID_RE.test(reqParam)) {
    return c.json({ error: "req must be a requirement id (KEY-NNN)" }, 400);
  }
  const { rows } = reqTags(storage, reqParam);
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
 * SQL bugs, plain Errors) re-throws unchanged — never silently
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
      // @spec SERV-027
      if (err instanceof InvalidDomainFilesError) {
        return c.json(
          { error: "invalid_domain_file", diagnostics: sortDiagnostics(err.diagnostics) },
          422,
        );
      }
      const info = describeStorageError(err);
      if (info === null) throw err;
      console.error(`spec serve: /api storage unavailable (${info.code}):`, err);
      return c.json({ error: "storage_unavailable", code: info.code, hint: info.hint }, 503);
    }
  };
}

/**
 * A requirement statement + why is a few hundred bytes; 64 KiB is generous
 * headroom while still rejecting a DoS-scale payload before it is parsed.
 * Enforced against both the `Content-Length` header (fast reject) and the
 * actual read length (a missing or lying header).
 */
const MAX_WRITE_BODY_BYTES = 64 * 1024;

/**
 * `POST /api/requirements` does read → compute-next-id → write → reindex with
 * no locking, so two concurrent POSTs could both read the same max seq and
 * mint the same id. A single local server needs nothing heavier than a promise
 * chain. `.then(fn, fn)` runs `fn` whether the prior link resolved or rejected
 * (a failed write must not wedge the chain); the stored link swallows errors
 * so an unhandled rejection never escapes.
 */
let writeChain: Promise<unknown> = Promise.resolve();
function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.catch(() => {});
  return run;
}

/**
 * The Host pin defends against DNS rebinding. The Origin check runs only when
 * the header is present because the webapp's in-process forward sends none.
 */
function rejectCrossOrigin(c: Context, bindHost: string): Response | null {
  const selfUrl = new URL(c.req.url);
  if (!isServedHostname(selfUrl.hostname, bindHost)) {
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

async function readJsonBody(
  c: Context,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; res: Response }> {
  let raw: string;
  try {
    raw = await c.req.text();
  } catch {
    return { ok: false, res: c.json({ error: "invalid request body" }, 400) };
  }
  // Cap on BYTE length, not UTF-16 code units — a multibyte payload
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

/** Mirrors the `req.ts` / `amend.ts` list-field recipe. */
function toStringList(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  if (typeof v === "string" && v.length > 0) return [v];
  return [];
}

/** A POST body's authored fields; anything absent or mistyped takes the empty value. */
function mintFieldsFromBody(body: Record<string, unknown>) {
  return {
    statement: typeof body.statement === "string" ? body.statement : "",
    why: typeof body.why === "string" ? body.why : "",
    relates: toStringList(body.relates),
    issue:
      typeof body.issue === "string" && body.issue.trim() !== "" ? body.issue.trim() : undefined,
    status: body.status === "draft" ? ("draft" as const) : ("active" as const),
  };
}

/** A supersede body's optional successor fields; an absent field is copied from the predecessor. */
function successorFieldsFromBody(body: Record<string, unknown>) {
  return {
    why: typeof body.why === "string" ? body.why : undefined,
    relates: "relates" in body ? toStringList(body.relates) : undefined,
    issue:
      typeof body.issue === "string" && body.issue.trim() !== "" ? body.issue.trim() : undefined,
  };
}

/** The amendable fields named in a PUT body, or null when it names none. */
function amendFieldsFromBody(body: Record<string, unknown>): AmendFields | null {
  const fields: AmendFields = {};
  if (typeof body.statement === "string") fields.statement = body.statement;
  if ("why" in body) fields.why = typeof body.why === "string" ? body.why : null;
  if ("relates" in body) fields.relates = toStringList(body.relates);
  return Object.keys(fields).length === 0 ? null : fields;
}

/** An operation's refusal as the HTTP response its reason maps to. */
function failureResponse(c: Context, failure: OpFailure): Response {
  if (failure.reason === "not_found") return c.json({ error: "not found" }, 404);
  if (failure.reason === "invalid_domain_file") {
    return failure.diagnostics
      ? c.json({ error: "INVALID_DOMAIN_FILE", diagnostics: failure.diagnostics }, 400)
      : c.json({ error: "INVALID_DOMAIN_FILE", detail: failure.detail }, 400);
  }
  return c.json({ error: failure.detail }, STATUS_FOR_REASON[failure.reason]);
}

/** The `/api/query` response: hits, or a sanitized 400 on an FTS5 grammar error. */
function searchFtsResponse(c: Context, storage: Storage, q: string, limit: number): Response {
  const r = query(storage, q, limit);
  return r.ok ? c.json(r.hits) : c.json({ error: r.detail }, 400);
}

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
 * Tracker resolution for `/api/provenance?resolve=1` runs engine-side because
 * the webapp's import fence forbids it importing `@spec-engine/tracker`; it
 * reads the decorated text instead.
 *
 * @spec SCHM-041
 * @spec SERV-010
 */
export function mountApi(
  app: Hono,
  storage: Storage,
  platformDir: string = process.cwd(),
  bindHost: string = DEFAULT_BIND_HOST,
): Hono {
  // A derived-index response must never be cached across reindexes. The header
  // is set before next() so it survives a thrown handler: headers set before
  // next() land on Hono's 500 too, while a set after next() is unreachable.
  app.use("/api/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });

  // --- /api/coverage ------------------------------------------------------

  app.get(
    "/api/coverage",
    guarded((c) => c.json(coverageMatrix(storage).rows)),
  );

  // --- /api/repos ---------------------------------------------------------
  // Discovery-only hints (selfMember/ignore) are absent from stored rows.

  app.get(
    "/api/repos",
    guarded((c) => c.json(storage.listRepos())),
  );

  // --- /api/platform ------------------------------------------------------

  app.get("/api/platform", async (c) => {
    const version = await derivePlatformVersion(platformDir);
    const info: PlatformInfo = {
      version,
      name: platformName(platformDir),
      source: "derived",
      mode: platformMode(platformDir),
    };
    return c.json(info);
  });

  // --- /api/report ----------------------------------------------------------
  // The rollup reads the same coverage view /api/coverage serves, so the
  // report can never disagree with the matrix.

  app.get(
    "/api/report",
    guarded((c) => c.json(coverageReport(storage).rows)),
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
      return c.json(listRecords(storage, { key, status }).rows);
    }),
  );

  app.get(
    "/api/requirements/:id",
    guarded((c) => {
      const id = c.req.param("id") ?? "";
      const { row } = getRecord(storage, id);
      return row ? c.json(row) : c.json({ error: "not found" }, 404);
    }),
  );

  // --- POST /api/requirements --------------------------------------------
  //
  // On a structural reject the route returns the diagnostics the shared
  // validator emits, unreshaped.
  app.post(
    "/api/requirements",
    guarded(async function createRequirement(c) {
      // The editor feature flag gates the whole write plane, not just the
      // form: off means these endpoints answer 404.
      if (!featureEnabled("editor")) {
        return c.json({ error: featureDisabledMessage("editor") }, 404);
      }
      const originReject = rejectCrossOrigin(c, bindHost);
      if (originReject) return originReject;
      const headerReject = rejectBadWriteHeaders(c);
      if (headerReject) return headerReject;
      const parsed = await readJsonBody(c);
      if (!parsed.ok) return parsed.res;
      const body = parsed.body;

      const key = normalizeDomainKey(typeof body.key === "string" ? body.key : "");
      if (key === "" || !listDomainKeys(platformDir).includes(key)) {
        return c.json({ error: "unknown domain key" }, 400);
      }

      return withWriteLock(async () => {
        const r = await mint({ platformDir, key, ...mintFieldsFromBody(body) });
        if (!r.ok) return failureResponse(c, r);
        await runIndex({ platformDir, storage });
        return c.json({ ok: true, id: r.id }, 201);
      });
    }),
  );

  // --- PUT /api/requirements/:id -----------------------------------------
  app.put(
    "/api/requirements/:id",
    guarded(async function amendRequirement(c) {
      if (!featureEnabled("editor")) {
        return c.json({ error: featureDisabledMessage("editor") }, 404);
      }
      const originReject = rejectCrossOrigin(c, bindHost);
      if (originReject) return originReject;
      const headerReject = rejectBadWriteHeaders(c);
      if (headerReject) return headerReject;
      const parsed = await readJsonBody(c);
      if (!parsed.ok) return parsed.res;
      const body = parsed.body;

      const id = c.req.param("id") ?? "";

      return withWriteLock(async () => {
        const fields = amendFieldsFromBody(body);
        if (fields === null) {
          return c.json({ error: "nothing to amend — provide statement, why, or relates" }, 400);
        }
        const r = await amend({ platformDir, id, fields });
        if (!r.ok) return failureResponse(c, r);
        await runIndex({ platformDir, storage });
        return c.json({ ok: true, id }, 200);
      });
    }),
  );

  // --- POST /api/requirements/:id/supersede -------------------------------
  //
  // The operation re-indexes into this handle after the retag, so the
  // index is current when the response goes out.
  app.post(
    "/api/requirements/:id/supersede",
    guarded(async function supersedeRequirement(c) {
      if (!featureEnabled("editor")) {
        return c.json({ error: featureDisabledMessage("editor") }, 404);
      }
      const originReject = rejectCrossOrigin(c, bindHost);
      if (originReject) return originReject;
      const headerReject = rejectBadWriteHeaders(c);
      if (headerReject) return headerReject;
      const parsed = await readJsonBody(c);
      if (!parsed.ok) return parsed.res;
      const body = parsed.body;

      const id = c.req.param("id") ?? "";
      if (!ID_RE.test(id)) return c.json({ error: "id must be a requirement id (KEY-NNN)" }, 400);
      const statement = typeof body.statement === "string" ? body.statement.trim() : "";
      if (statement === "") return c.json({ error: "statement is required (non-empty)" }, 400);

      return withWriteLock(async () => {
        const r = await supersede(
          { platformDir, id, statement, ...successorFieldsFromBody(body) },
          async (reqId) => {
            await runIndex({ platformDir, storage });
            return storage.listTags({ req_id: reqId });
          },
        );
        if (!r.ok) return failureResponse(c, r);
        return c.json(
          {
            ok: true,
            old_id: r.oldId,
            new_id: r.newId,
            file: r.file,
            spec_version: r.specVersion,
            retagged: r.retagged,
          },
          201,
        );
      });
    }),
  );

  // --- POST /api/requirements/:id/move ------------------------------------
  // @spec SCHM-043
  app.post(
    "/api/requirements/:id/move",
    guarded(async function moveRequirement(c) {
      if (!featureEnabled("editor")) {
        return c.json({ error: featureDisabledMessage("editor") }, 404);
      }
      const originReject = rejectCrossOrigin(c, bindHost);
      if (originReject) return originReject;
      const headerReject = rejectBadWriteHeaders(c);
      if (headerReject) return headerReject;
      const parsed = await readJsonBody(c);
      if (!parsed.ok) return parsed.res;
      const body = parsed.body;

      const id = c.req.param("id") ?? "";
      if (!ID_RE.test(id)) return c.json({ error: "id must be a requirement id (KEY-NNN)" }, 400);
      const targetKey = normalizeDomainKey(
        typeof body.newDomain === "string" ? body.newDomain : "",
      );
      if (targetKey === "") return c.json({ error: "newDomain is required (a domain key)" }, 400);

      return withWriteLock(async () => {
        const r = await move(
          {
            platformDir,
            id,
            targetKey,
            statement: typeof body.text === "string" ? body.text : undefined,
            why: typeof body.why === "string" ? body.why : undefined,
          },
          async (reqId) => {
            await runIndex({ platformDir, storage });
            return storage.listTags({ req_id: reqId });
          },
        );
        if (!r.ok) return failureResponse(c, r);
        return c.json(
          {
            ok: true,
            old_id: r.oldId,
            new_id: r.newId,
            from_file: r.fromFile,
            to_file: r.toFile,
            source_spec_version: r.sourceSpecVersion,
            target_spec_version: r.targetSpecVersion,
            retagged: r.retagged,
          },
          201,
        );
      });
    }),
  );

  // --- POST /api/requirements/:id/deprecate -------------------------------
  app.post(
    "/api/requirements/:id/deprecate",
    guarded(async function deprecateRequirement(c) {
      if (!featureEnabled("editor")) {
        return c.json({ error: featureDisabledMessage("editor") }, 404);
      }
      const originReject = rejectCrossOrigin(c, bindHost);
      if (originReject) return originReject;
      const headerReject = rejectBadWriteHeaders(c);
      if (headerReject) return headerReject;
      const parsed = await readJsonBody(c);
      if (!parsed.ok) return parsed.res;
      const body = parsed.body;

      const id = c.req.param("id") ?? "";
      if (!ID_RE.test(id)) return c.json({ error: "id must be a requirement id (KEY-NNN)" }, 400);
      const reason = typeof body.reason === "string" ? body.reason.trim() : "";
      if (reason === "") return c.json({ error: "reason is required (non-empty)" }, 400);

      return withWriteLock(async () => {
        const r = await deprecate({ platformDir, id, reason }, async (reqId) => {
          await runIndex({ platformDir, storage });
          return storage.listTags({ req_id: reqId });
        });
        if (!r.ok) return failureResponse(c, r);
        return c.json(
          { ok: true, id: r.id, file: r.file, reason: r.reason, removed: r.removed },
          200,
        );
      });
    }),
  );

  // --- POST /api/requirements/:id/accept ---------------------------------
  app.post(
    "/api/requirements/:id/accept",
    guarded(async function acceptRequirement(c) {
      if (!featureEnabled("editor")) {
        return c.json({ error: featureDisabledMessage("editor") }, 404);
      }
      const originReject = rejectCrossOrigin(c, bindHost);
      if (originReject) return originReject;
      const headerReject = rejectBadWriteHeaders(c);
      if (headerReject) return headerReject;
      const parsed = await readJsonBody(c);
      if (!parsed.ok) return parsed.res;

      const id = c.req.param("id") ?? "";
      if (!ID_RE.test(id)) return c.json({ error: "id must be a requirement id (KEY-NNN)" }, 400);

      return withWriteLock(async () => {
        const r = await accept({ platformDir, id });
        if (!r.ok) return failureResponse(c, r);
        await runIndex({ platformDir, storage });
        return c.json({ ok: true, id: r.id, file: r.file }, 200);
      });
    }),
  );

  // --- /api/propagation/:id ----------------------------------------------

  app.get(
    "/api/propagation/:id",
    guarded((c) => c.json(propagation(storage, c.req.param("id") ?? "").rows)),
  );

  // --- /api/query --------------------------------------------------------

  app.get(
    "/api/query",
    guarded((c) => {
      // @spec SERV-032
      if (!featureEnabled("query")) {
        return c.json({ error: featureDisabledMessage("query") }, 404);
      }
      const q = (c.req.query("q") ?? "").trim();
      if (!q) {
        return c.json({ error: "q is required (non-empty FTS5 MATCH query)" }, 400);
      }

      const rawLimit = c.req.query("limit") ?? String(DEFAULT_QUERY_LIMIT);
      const parsedLimit = parseQueryLimit(c, rawLimit);
      if (!parsedLimit.ok) return parsedLimit.res;

      return searchFtsResponse(c, storage, q, parsedLimit.limit);
    }),
  );

  // --- /api/relations ------------------------------------------------------

  app.get(
    "/api/relations",
    guarded((c) => {
      // @spec SERV-032
      if (!featureEnabled("relations")) {
        return c.json({ error: featureDisabledMessage("relations") }, 404);
      }
      // The webapp /relations page reads this text seam because its import
      // fence forbids importing @spec-engine/spec-engine directly.
      const format = c.req.query("format");
      if (format !== undefined && format !== "mermaid") {
        return c.json({ error: 'format must be "mermaid" when provided' }, 400);
      }
      const rows = relations(storage).rows;
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
      // @spec SERV-032
      if (!featureEnabled("provenance")) {
        return c.json({ error: featureDisabledMessage("provenance") }, 404);
      }
      // The webapp /provenance page reads this text seam because its import
      // fence forbids importing @spec-engine/tracker.
      const resolveParam = c.req.query("resolve");
      if (resolveParam !== undefined && resolveParam !== "1") {
        return c.json({ error: 'resolve must be "1" when provided' }, 400);
      }
      const rows = provenance(storage).rows;
      if (resolveParam === "1") {
        // With no SPEC_TRACKER_TOKEN this degrades to the bare ids + the token
        // hint with no network call.
        const resolved = await resolveAndCache(rows, platformDir);
        return c.text(renderProvenanceDecorated(rows, resolved, "text"));
      }
      return c.json(rows);
    }),
  );

  // --- /api/provenance?issue= ---------------------------------------------
  // The issue id is a query value, not a path segment: an opaque tracker id
  // may contain any character, `/` included, and a ticket is a filter value,
  // never an address.

  app.get(
    "/api/provenance/by-issue",
    guarded((c) => {
      // @spec SERV-032
      if (!featureEnabled("provenance")) {
        return c.json({ error: featureDisabledMessage("provenance") }, 404);
      }
      const issue = (c.req.query("issue") ?? "").trim();
      if (issue === "") return c.json({ error: "issue is required (non-empty)" }, 400);
      return c.json(provenance(storage, issue).rows);
    }),
  );

  // --- /api/resolve ------------------------------------------------------

  app.get(
    "/api/resolve",
    guarded((c) => {
      const reqParam = c.req.query("req");
      if (reqParam !== undefined) return resolveByReq(c, storage, reqParam);

      const files = c.req.queries("files") ?? [];

      if (files.length === 0) {
        return c.json({ error: "files query is required (one or more)" }, 400);
      }

      // An uncapped `?files=` list could blow past SQLITE_MAX_VARIABLE_NUMBER
      // (32766) in storage.resolveByFiles. The CLI seam enforces the same cap.
      if (files.length > FILES_MAX) {
        return c.json({ error: `too many files (max ${FILES_MAX} per request)` }, 400);
      }

      // The route has no platformDir, so containment is the CLI's job. A shape
      // check suffices here because storage stores tag files platform-relative:
      // an absolute or traversal path can never match a real tag, and rejecting
      // it up front gives a clear error instead of a silent empty result.
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
