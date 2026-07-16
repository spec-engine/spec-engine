// packages/tracker/src/linear.ts — the one concrete linearAdapter.
//
// A READ-ONLY GraphQL reader for Linear `ENG-NNNN` ids. It POSTs a GraphQL read
// `query` (TRK-04 one-way truth — never a GraphQL write) to Linear's GraphQL API
// and converts EVERY failure mode into the no-throw `TrackerResult` union (TRK-05)
// so it can never crash the caller.
//
// LOCKED INTERPRETATION (RESEARCH A1): "GET/query only" = READ-ONLY / NO GraphQL
// writes. Linear's API is GraphQL-over-POST, so the HTTP verb is POST; what is
// forbidden is a GraphQL write document. The document below is a read `query`; the
// GraphQL write keyword does NOT appear in this file (Plan 04 fence backstops it).
//
// Auth (TRK-06): the token is read ONCE from `process.env.SPEC_TRACKER_TOKEN` and
// sent as a RAW `Authorization` header with NO scheme prefix (the Linear gotcha —
// a token-scheme prefix fails auth). It is never logged, never returned in a
// reason, never thrown.
//
// Tests inject a stub via the optional `fetchImpl` seam so no test touches the
// network or `globalThis.fetch`.

import type { TrackerAdapter } from "./adapter";
import type { TrackerReason, TrackerResult } from "./types";

/** Linear's GraphQL endpoint — the ONLY external host literal in the codebase. */
const LINEAR_ENDPOINT = "https://api.linear.app/graphql";

/** linearAdapter claims `ENG-NNNN` ids only. */
const ISSUE_RE = /^ENG-\d+$/;

/** Per-request timeout — a hung tracker can never stall the caller (TRK-05 / DoS). */
const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Read-only GraphQL document. The id is bound as the `$id` VARIABLE — never
 * string-interpolated into the query (injection-safe; mirrors Phase 13 `$issue`
 * discipline). This is a read document; it carries no GraphQL write.
 *
 * @spec TRK-002 — the tracker sends only a GraphQL read `query`, never a
 * mutation, so requirement state is looked up but never written back.
 */
const ISSUE_QUERY = "query($id:String!){ issue(id:$id){ title state{ name } url } }";

/**
 * Map an HTTP status to a terminal degraded reason, or null when the response
 * body should be parsed (a 2xx, or an unknown status we fall through on).
 *
 * 2.4: a 5xx means the tracker is reachable but erroring — NOT an authoritative
 * "unknown id". It is classified BEFORE the body is parsed (a 502 gateway page
 * is typically HTML → would otherwise mis-map to `malformed`, or a shapeless
 * JSON error → `not_found`). Distinct from `offline` (no connection) and
 * `timeout` (no response in time).
 */
function statusReason(status: number): TrackerReason | null {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 429) return "rate_limited";
  if (status === 404) return "not_found";
  if (status >= 500) return "server_error";
  return null;
}

/**
 * Resolve a single id against Linear via the injected `fetchImpl`. Catches every
 * failure and returns a `{ok:false, reason, id}` — it RESOLVES, never rejects.
 * The `token` is already validated non-empty by the caller.
 */
async function resolveOne(
  id: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<TrackerResult> {
  let res: Response;
  try {
    res = await fetchImpl(LINEAR_ENDPOINT, {
      method: "POST", // Linear is GraphQL-over-POST; the document is a read query.
      headers: {
        "Content-Type": "application/json",
        // RAW token — NO scheme prefix (Linear personal keys fail with a prefix).
        Authorization: token,
      },
      body: JSON.stringify({ query: ISSUE_QUERY, variables: { id } }),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch (e) {
    // TimeoutError → timeout; any other network/connect error → offline.
    const reason = (e as Error)?.name === "TimeoutError" ? "timeout" : "offline";
    return { ok: false, id, reason };
  }

  const reason = statusReason(res.status);
  if (reason) return { ok: false, id, reason };

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return { ok: false, id, reason: "malformed" };
  }

  // A GraphQL error body (HTTP 200 + non-empty top-level `errors[]`) is NOT an
  // unknown id — Linear returns it for auth/permission/validation failures. Map
  // auth-class errors to `unauthorized`, everything else to `malformed`. Never
  // interpolate any `errors[].message` into a reason (keep it on the fixed union;
  // no server-side detail — and certainly no token — can leak into output).
  const body = json as { data?: { issue?: unknown }; errors?: unknown[] } | null | undefined;
  if (Array.isArray(body?.errors) && body.errors.length > 0) {
    const authError = body.errors.some((err) => {
      const e = err as { message?: unknown; extensions?: { code?: unknown } } | null;
      const code = typeof e?.extensions?.code === "string" ? e.extensions.code : "";
      const message = typeof e?.message === "string" ? e.message : "";
      return /authentication|unauthenticated|unauthorized/i.test(`${code} ${message}`);
    });
    return { ok: false, id, reason: authError ? "unauthorized" : "malformed" };
  }

  // Only a clean `data.issue == null` is a genuine "unknown id" → not_found.
  const issue = body?.data?.issue as
    | { title?: unknown; url?: unknown; state?: { name?: unknown } }
    | null
    | undefined;
  if (!issue) return { ok: false, id, reason: "not_found" };

  // Field-shape mismatch → malformed (never trust the response shape blindly).
  if (
    typeof issue.title !== "string" ||
    typeof issue.url !== "string" ||
    typeof issue.state?.name !== "string"
  ) {
    return { ok: false, id, reason: "malformed" };
  }

  return {
    ok: true,
    id,
    value: { title: issue.title, status: issue.state.name, url: issue.url },
  };
}

/**
 * 2.4: resolve a deduped id list sequentially, with a connection-wide
 * short-circuit. A terminal `unauthorized` / `rate_limited` (a bad key or a
 * throttle) applies to EVERY remaining id, so once one trips, the rest degrade
 * to the same reason without further requests — avoiding N × 5s timeout stalls.
 * Foreign-tracker ids (rejected by `matches`) never touch the endpoint.
 */
async function resolveMany(
  unique: string[],
  token: string,
  fetchImpl: typeof fetch,
  matches: (id: string) => boolean,
): Promise<Map<string, TrackerResult>> {
  const out = new Map<string, TrackerResult>();
  let terminal: TrackerReason | null = null;
  for (const id of unique) {
    if (terminal) {
      out.set(id, { ok: false, id, reason: terminal });
    } else if (!matches(id)) {
      out.set(id, { ok: false, id, reason: "not_found" });
    } else {
      const r = await resolveOne(id, token, fetchImpl);
      out.set(id, r);
      if (!r.ok && (r.reason === "unauthorized" || r.reason === "rate_limited")) {
        terminal = r.reason;
      }
    }
  }
  return out;
}

/**
 * Build a linearAdapter bound to a specific `fetchImpl`. The default uses Bun's
 * built-in `fetch`; tests pass a stub so no network is touched and the request can
 * be captured. The token is read ONCE per `resolveIssues` call from the
 * environment; an empty/missing token short-circuits EVERY id to `unauthorized`
 * with NO fetch (TRK-06).
 */
export function makeLinearAdapter(fetchImpl: typeof fetch = fetch): TrackerAdapter {
  return {
    name: "linear",
    matches: (id) => ISSUE_RE.test(id),
    async resolveIssues(ids) {
      // @spec TRK-003 — read SPEC_TRACKER_TOKEN once from the environment, send it
      // only as the raw Authorization header, never write it to a console.* call.
      // Trim first: a whitespace-only token (stray space / trailing newline from a
      // shell or `.env`) is treated as ABSENT — empty after trim → no network.
      const token = process.env.SPEC_TRACKER_TOKEN?.trim();
      // 2.4: dedupe — a repeated id must not trigger a repeated fetch.
      const unique = [...new Set(ids)];

      // No token → no network. Degrade every id to unauthorized.
      if (!token) {
        const out = new Map<string, TrackerResult>();
        for (const id of unique) out.set(id, { ok: false, id, reason: "unauthorized" });
        return out;
      }

      return resolveMany(unique, token, fetchImpl, (id) => ISSUE_RE.test(id));
    },
  };
}

/** The default linearAdapter, bound to Bun's built-in `fetch`. */
export const linearAdapter: TrackerAdapter = makeLinearAdapter();
