// Every test injects a fetch stub through `makeLinearAdapter(fetchImpl)`, so
// none touches the network or `globalThis.fetch`.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeLinearAdapter } from "./linear";

const TOKEN = "lin_test_dummy_token";

interface Captured {
  url: string;
  method?: string | undefined;
  headers: Record<string, string>;
  body: string;
}

/** The call-count box lets a test assert the stub was, or was not, called. */
function makeStub(
  script: { kind: "response"; status: number; body: string } | { kind: "throw"; error: Error },
) {
  const calls: Captured[] = [];
  const stub = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({
      url: String(url),
      method: init?.method,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: String(init?.body ?? ""),
    });
    if (script.kind === "throw") throw script.error;
    return new Response(script.body, { status: script.status });
  }) as unknown as typeof fetch;
  return { stub, calls };
}

const OK_BODY = JSON.stringify({
  data: {
    issue: {
      title: "Fix renewal charge",
      state: { name: "In Progress" },
      url: "https://linear.app/x/issue/ENG-1",
    },
  },
});

describe("linearAdapter — no-throw degraded ladder (injected fetch)", () => {
  beforeEach(() => {
    process.env.SPEC_TRACKER_TOKEN = TOKEN;
  });
  afterEach(() => {
    delete process.env.SPEC_TRACKER_TOKEN;
  });

  test("matches() claims ENG-NNNN only", () => {
    const { stub } = makeStub({ kind: "response", status: 200, body: OK_BODY });
    const adapter = makeLinearAdapter(stub);
    expect(adapter.name).toBe("linear");
    expect(adapter.matches("ENG-7")).toBe(true);
    expect(adapter.matches("ENG-1234")).toBe(true);
    expect(adapter.matches("FOO-1")).toBe(false);
    expect(adapter.matches("BILLING-009")).toBe(false);
    expect(adapter.matches("ENG-")).toBe(false);
  });

  test("ok value: stubbed 200 → {ok:true, value:{title,status,url}}", async () => {
    const { stub } = makeStub({ kind: "response", status: 200, body: OK_BODY });
    const out = await makeLinearAdapter(stub).resolveIssues(["ENG-1"]);
    expect(out.get("ENG-1")).toEqual({
      ok: true,
      id: "ENG-1",
      value: {
        title: "Fix renewal charge",
        status: "In Progress",
        url: "https://linear.app/x/issue/ENG-1",
      },
    });
  });

  // @spec TRK-008 unit
  test("unauthorized (no token): unset token → all unauthorized, NO fetch", async () => {
    delete process.env.SPEC_TRACKER_TOKEN;
    const { stub, calls } = makeStub({ kind: "response", status: 200, body: OK_BODY });
    const out = await makeLinearAdapter(stub).resolveIssues(["ENG-1", "ENG-2"]);
    expect(out.get("ENG-1")).toEqual({ ok: false, id: "ENG-1", reason: "unauthorized" });
    expect(out.get("ENG-2")).toEqual({ ok: false, id: "ENG-2", reason: "unauthorized" });
    expect(calls.length).toBe(0); // injected fetch never called
  });

  test("unauthorized (401) → reason unauthorized", async () => {
    const { stub } = makeStub({ kind: "response", status: 401, body: "" });
    const out = await makeLinearAdapter(stub).resolveIssues(["ENG-1"]);
    expect(out.get("ENG-1")).toEqual({ ok: false, id: "ENG-1", reason: "unauthorized" });
  });

  test("unauthorized (403) → reason unauthorized", async () => {
    const { stub } = makeStub({ kind: "response", status: 403, body: "" });
    const out = await makeLinearAdapter(stub).resolveIssues(["ENG-1"]);
    expect(out.get("ENG-1")).toEqual({ ok: false, id: "ENG-1", reason: "unauthorized" });
  });

  test("rate_limited (429) → reason rate_limited", async () => {
    const { stub } = makeStub({ kind: "response", status: 429, body: "" });
    const out = await makeLinearAdapter(stub).resolveIssues(["ENG-1"]);
    expect(out.get("ENG-1")).toEqual({ ok: false, id: "ENG-1", reason: "rate_limited" });
  });

  test("not_found (404) → reason not_found", async () => {
    const { stub } = makeStub({ kind: "response", status: 404, body: "" });
    const out = await makeLinearAdapter(stub).resolveIssues(["ENG-999"]);
    expect(out.get("ENG-999")).toEqual({ ok: false, id: "ENG-999", reason: "not_found" });
  });

  test("not_found (200 + data.issue:null) → reason not_found", async () => {
    const { stub } = makeStub({
      kind: "response",
      status: 200,
      body: JSON.stringify({ data: { issue: null } }),
    });
    const out = await makeLinearAdapter(stub).resolveIssues(["ENG-404"]);
    expect(out.get("ENG-404")).toEqual({ ok: false, id: "ENG-404", reason: "not_found" });
  });

  test("errors[] (200 + auth GraphQL error) → reason unauthorized, no throw", async () => {
    const { stub } = makeStub({
      kind: "response",
      status: 200,
      body: JSON.stringify({
        errors: [{ message: "Authentication required", extensions: { code: "UNAUTHENTICATED" } }],
      }),
    });
    const out = await makeLinearAdapter(stub).resolveIssues(["ENG-1"]);
    expect(out.get("ENG-1")).toEqual({ ok: false, id: "ENG-1", reason: "unauthorized" });
  });

  test("errors[] (200 + non-auth GraphQL error) → reason malformed, not not_found", async () => {
    const { stub } = makeStub({
      kind: "response",
      status: 200,
      body: JSON.stringify({ errors: [{ message: "Query complexity exceeded" }] }),
    });
    const out = await makeLinearAdapter(stub).resolveIssues(["ENG-1"]);
    // A real API error must NOT be collapsed into a clean "not_found".
    expect(out.get("ENG-1")).toEqual({ ok: false, id: "ENG-1", reason: "malformed" });
  });

  test("whitespace-only token → all unauthorized, NO fetch", async () => {
    process.env.SPEC_TRACKER_TOKEN = "   \n";
    const { stub, calls } = makeStub({ kind: "response", status: 200, body: OK_BODY });
    const out = await makeLinearAdapter(stub).resolveIssues(["ENG-1", "ENG-2"]);
    expect(out.get("ENG-1")).toEqual({ ok: false, id: "ENG-1", reason: "unauthorized" });
    expect(out.get("ENG-2")).toEqual({ ok: false, id: "ENG-2", reason: "unauthorized" });
    expect(calls.length).toBe(0); // whitespace token is treated as absent — no network
  });

  test("offline (network error) → reason offline", async () => {
    const { stub } = makeStub({ kind: "throw", error: new Error("network unreachable") });
    const out = await makeLinearAdapter(stub).resolveIssues(["ENG-1"]);
    expect(out.get("ENG-1")).toEqual({ ok: false, id: "ENG-1", reason: "offline" });
  });

  test("timeout (TimeoutError) → reason timeout", async () => {
    const err = new Error("The operation timed out.");
    err.name = "TimeoutError";
    const { stub } = makeStub({ kind: "throw", error: err });
    const out = await makeLinearAdapter(stub).resolveIssues(["ENG-1"]);
    expect(out.get("ENG-1")).toEqual({ ok: false, id: "ENG-1", reason: "timeout" });
  });

  test("malformed (non-JSON body) → reason malformed", async () => {
    const { stub } = makeStub({ kind: "response", status: 200, body: "<<<not json>>>" });
    const out = await makeLinearAdapter(stub).resolveIssues(["ENG-1"]);
    expect(out.get("ENG-1")).toEqual({ ok: false, id: "ENG-1", reason: "malformed" });
  });

  test("malformed (wrong-shape data.issue) → reason malformed", async () => {
    const { stub } = makeStub({
      kind: "response",
      status: 200,
      body: JSON.stringify({ data: { issue: { title: 42, state: {}, url: null } } }),
    });
    const out = await makeLinearAdapter(stub).resolveIssues(["ENG-1"]);
    expect(out.get("ENG-1")).toEqual({ ok: false, id: "ENG-1", reason: "malformed" });
  });

  test("never throws: every path resolves to a Map (no rejection)", async () => {
    const scripts: ReturnType<typeof makeStub>["stub"][] = [
      makeStub({ kind: "response", status: 200, body: OK_BODY }).stub,
      makeStub({ kind: "response", status: 401, body: "" }).stub,
      makeStub({ kind: "response", status: 429, body: "" }).stub,
      makeStub({ kind: "response", status: 404, body: "" }).stub,
      makeStub({ kind: "throw", error: new Error("offline") }).stub,
      makeStub({ kind: "response", status: 200, body: "nope" }).stub,
    ];
    for (const stub of scripts) {
      await expect(makeLinearAdapter(stub).resolveIssues(["ENG-1"])).resolves.toBeInstanceOf(Map);
    }
  });

  test("server_error (500) → reason server_error, not not_found/malformed", async () => {
    const { stub } = makeStub({ kind: "response", status: 500, body: "<html>Server Error</html>" });
    const out = await makeLinearAdapter(stub).resolveIssues(["ENG-1"]);
    expect(out.get("ENG-1")).toEqual({ ok: false, id: "ENG-1", reason: "server_error" });
  });

  test("server_error (502 gateway) → reason server_error", async () => {
    const { stub } = makeStub({ kind: "response", status: 502, body: "Bad Gateway" });
    const out = await makeLinearAdapter(stub).resolveIssues(["ENG-1"]);
    expect(out.get("ENG-1")).toEqual({ ok: false, id: "ENG-1", reason: "server_error" });
  });

  test("short-circuit: a 401 on the first id terminates the rest with ONE fetch", async () => {
    const { stub, calls } = makeStub({ kind: "response", status: 401, body: "" });
    const out = await makeLinearAdapter(stub).resolveIssues(["ENG-1", "ENG-2", "ENG-3"]);
    // Every id degrades to unauthorized...
    expect(out.get("ENG-1")).toEqual({ ok: false, id: "ENG-1", reason: "unauthorized" });
    expect(out.get("ENG-2")).toEqual({ ok: false, id: "ENG-2", reason: "unauthorized" });
    expect(out.get("ENG-3")).toEqual({ ok: false, id: "ENG-3", reason: "unauthorized" });
    // ...but only ONE request was made — the terminal condition short-circuited.
    expect(calls.length).toBe(1);
  });

  test("short-circuit: a 429 terminates the rest with ONE fetch", async () => {
    const { stub, calls } = makeStub({ kind: "response", status: 429, body: "" });
    await makeLinearAdapter(stub).resolveIssues(["ENG-1", "ENG-2"]);
    expect(calls.length).toBe(1);
  });

  test("dedupe: a repeated id is fetched once", async () => {
    const { stub, calls } = makeStub({ kind: "response", status: 200, body: OK_BODY });
    const out = await makeLinearAdapter(stub).resolveIssues(["ENG-1", "ENG-1", "ENG-1"]);
    expect(out.get("ENG-1")).toMatchObject({ ok: true });
    expect(calls.length).toBe(1);
  });

  test("self-filter: a foreign-tracker id never touches Linear's API", async () => {
    const { stub, calls } = makeStub({ kind: "response", status: 200, body: OK_BODY });
    const out = await makeLinearAdapter(stub).resolveIssues(["JIRA-42"]);
    expect(out.get("JIRA-42")).toEqual({ ok: false, id: "JIRA-42", reason: "not_found" });
    expect(calls.length).toBe(0); // never fetched — matches() rejected it
  });

  // @spec TRK-008 unit
  test("raw auth header: Authorization EQUALS the token (no scheme prefix)", async () => {
    const { stub, calls } = makeStub({ kind: "response", status: 200, body: OK_BODY });
    await makeLinearAdapter(stub).resolveIssues(["ENG-1"]);
    expect(calls.length).toBe(1);
    const captured = calls[0];
    expect(captured).toBeDefined();
    const auth = captured?.headers.Authorization;
    expect(auth).toBe(TOKEN);
    expect(auth).not.toContain("Bearer");
  });

  // @spec TRK-007 unit
  test("read-only body: query binds $id and carries no GraphQL write keyword", async () => {
    const { stub, calls } = makeStub({ kind: "response", status: 200, body: OK_BODY });
    await makeLinearAdapter(stub).resolveIssues(["ENG-1"]);
    expect(calls.length).toBe(1);
    const captured = calls[0];
    expect(captured).toBeDefined();
    const parsed = JSON.parse(captured?.body ?? "{}") as {
      query: string;
      variables: { id: string };
    };
    expect(parsed.query).toContain("query(");
    expect(parsed.query).toContain("$id");
    expect(parsed.query).not.toContain("ENG-1");
    expect(parsed.variables).toEqual({ id: "ENG-1" });
    expect(parsed.query).not.toContain("muta" + "tion");
  });
});
