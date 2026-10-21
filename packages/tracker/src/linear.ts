// Linear's API is GraphQL-over-POST, so the verb is POST; what is forbidden is
// a GraphQL write document. Every failure becomes the no-throw `TrackerResult`
// union. The token is sent raw, with no scheme prefix (Linear rejects one), and
// is never logged, returned in a reason, or thrown.

import type { TrackerAdapter } from "./adapter";
import type { TrackerReason, TrackerResult } from "./types";

/** The only external host literal in the codebase. */
const LINEAR_ENDPOINT = "https://api.linear.app/graphql";

const ISSUE_RE = /^ENG-\d+$/;

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * The id is bound as the `$id` variable, never interpolated into the query.
 * @spec TRK-005
 */
const ISSUE_QUERY = "query($id:String!){ issue(id:$id){ title state{ name } url } }";

/**
 * Null means parse the body. A 5xx is classified before parsing: the tracker
 * is reachable but erroring, and a gateway's HTML page would otherwise read as
 * `malformed`, or a shapeless JSON error as `not_found`.
 */
function statusReason(status: number): TrackerReason | null {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 429) return "rate_limited";
  if (status === 404) return "not_found";
  if (status >= 500) return "server_error";
  return null;
}

/** Resolves, never rejects. */
async function resolveOne(
  id: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<TrackerResult> {
  let res: Response;
  try {
    res = await fetchImpl(LINEAR_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: token,
      },
      body: JSON.stringify({ query: ISSUE_QUERY, variables: { id } }),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch (e) {
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

  // Linear answers auth and validation failures with HTTP 200 and `errors[]`;
  // that is not an unknown id. No `errors[].message` ever reaches a reason, so
  // no server detail or token can leak into output.
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

  // Only a clean `data.issue == null` is an unknown id.
  const issue = body?.data?.issue as
    | { title?: unknown; url?: unknown; state?: { name?: unknown } }
    | null
    | undefined;
  if (!issue) return { ok: false, id, reason: "not_found" };

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
 * An `unauthorized` or `rate_limited` result applies to every remaining id, so
 * once one trips the rest degrade without a request, instead of N timeouts.
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

/** `fetchImpl` is the test seam: a stub keeps tests off the network. */
export function makeLinearAdapter(fetchImpl: typeof fetch = fetch): TrackerAdapter {
  return {
    name: "linear",
    matches: (id) => ISSUE_RE.test(id),
    async resolveIssues(ids) {
      // @spec TRK-006
      // A whitespace-only token (a stray newline from a shell or `.env`) is absent.
      const token = process.env.SPEC_TRACKER_TOKEN?.trim();
      const unique = [...new Set(ids)];

      if (!token) {
        const out = new Map<string, TrackerResult>();
        for (const id of unique) out.set(id, { ok: false, id, reason: "unauthorized" });
        return out;
      }

      return resolveMany(unique, token, fetchImpl, (id) => ISSUE_RE.test(id));
    },
  };
}

export const linearAdapter: TrackerAdapter = makeLinearAdapter();
