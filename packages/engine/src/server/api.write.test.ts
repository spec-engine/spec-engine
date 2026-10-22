// Everything is driven in-process through `app.request()`, never a
// `fetch("http://…")` port round-trip.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { copyFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Diagnostic, Storage } from "@spec-engine/shared";
import { DiagnosticCode, validateDomainFile } from "@spec-engine/shared";
import { nextRequirementId } from "../authoring/domains";
import { localToday } from "../authoring/edit";
import { renderDiagnostics } from "../check/format";
import { composeServeApp } from "../commands/serve";
import { openStorage } from "../storage/sqlite";
import { cloneFixture } from "../testing/cloneFixture";
import { commitAndTag } from "../testing/git";
import { TestPlatform } from "../testing/platform";

const CANONICAL_FIXTURE = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "..",
  "fixtures",
  "platform-fixture",
);
/** A planted SPEC.json that is not JSON at all. */
const NOT_JSON_SPEC = join(
  import.meta.dir,
  "..",
  "testing",
  "fixtures",
  "diagnostics",
  "not-json",
  "spec-engine",
  "BROKEN",
  "SPEC.json",
);

let platformDir: string;
let storage: Storage;
let app: ReturnType<typeof composeServeApp>;

let priorFlags: string | undefined;

beforeEach(() => {
  // The editor ships behind the shared feature flag; these tests exercise the
  // enabled behavior. Default-off behavior is covered in feature-flags.test.ts.
  priorFlags = process.env.SPEC_FLAGS;
  process.env.SPEC_FLAGS = "editor";
  platformDir = cloneFixture(CANONICAL_FIXTURE);
  storage = openStorage(join(platformDir, ".spec-engine", "test-index.sqlite"));
  app = composeServeApp(storage, platformDir);
});

afterEach(() => {
  if (priorFlags === undefined) delete process.env.SPEC_FLAGS;
  else process.env.SPEC_FLAGS = priorFlags;
  storage.close();
  rmSync(platformDir, { recursive: true, force: true });
});

function billingSpecPath(): string {
  return join(platformDir, "spec-engine", "BILLING", "SPEC.json");
}

function readBilling(): {
  requirements: Array<Record<string, unknown>>;
  updated: string;
  [k: string]: unknown;
} {
  return JSON.parse(readFileSync(billingSpecPath(), "utf8"));
}

describe("POST /api/requirements — create through validateAndWrite + runIndex", () => {
  test("a valid create returns 201 {ok,id} and a follow-up GET shows the new requirement", async () => {
    const res = await app.request("/api/requirements", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        key: "BILLING",
        statement: "When a refund is issued, reverse the tax previously collected.",
        why: "Refund correctness.",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: boolean; id: string };
    expect(body.ok).toBe(true);
    // BILLING already holds seq 1,2,7,9 → next is 010.
    expect(body.id).toBe("BILLING-010");

    const getRes = await app.request("/api/requirements?key=BILLING");
    expect(getRes.status).toBe(200);
    const rows = (await getRes.json()) as Array<{ id: string; text: string; status: string }>;
    const added = rows.find((r) => r.id === "BILLING-010");
    expect(added).toBeDefined();
    expect(added?.status).toBe("Active");
    expect(added?.text).toBe("When a refund is issued, reverse the tax previously collected.");

    const onDisk = readBilling().requirements.find((r) => r.id === "BILLING-010");
    expect(onDisk).toBeDefined();
    expect(onDisk?.status).toBe("active");
  });
});

function authSpecPath(): string {
  return join(platformDir, "spec-engine", "AUTH", "SPEC.json");
}

function readAuth(): { requirements: Array<Record<string, unknown>> } {
  return JSON.parse(readFileSync(authSpecPath(), "utf8"));
}

describe("PUT /api/requirements/:id — amend through the same seam", () => {
  // AUTH-001 is the fixture's Active-but-unbound requirement (the planted
  // orphan) — the only kind the amend gate lets through.
  test("amending statement returns 200, GET reflects it, untouched fields byte-identical", async () => {
    const before = readAuth().requirements.find((r) => r.id === "AUTH-001");
    expect(before).toBeDefined();
    const beforeWhy = before?.why;
    const beforeLives = before?.livesIn;

    const res = await app.request("/api/requirements/AUTH-001", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        statement: "When a session is idle for 30 days, the system shall expire it.",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; id: string };
    expect(body.ok).toBe(true);
    expect(body.id).toBe("AUTH-001");

    const getRes = await app.request("/api/requirements/AUTH-001");
    expect(getRes.status).toBe(200);
    const row = (await getRes.json()) as { text: string };
    expect(row.text).toBe("When a session is idle for 30 days, the system shall expire it.");

    const after = readAuth().requirements.find((r) => r.id === "AUTH-001");
    expect(after?.why).toEqual(beforeWhy);
    expect(after?.livesIn).toEqual(beforeLives);
  });

  // @spec REQ-057 unit
  test("a PUT with verifiedIn replaces the list; an empty list clears it", async () => {
    const put = (verifiedIn: string[]) =>
      app.request("/api/requirements/AUTH-001", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ verifiedIn }),
      });
    const verifiedIn = () => readAuth().requirements.find((r) => r.id === "AUTH-001")?.verifiedIn;
    expect((await put(["auth/test/session.test.ts"])).status).toBe(200);
    expect(verifiedIn()).toEqual(["auth/test/session.test.ts"]);
    expect((await put([])).status).toBe(200);
    expect(verifiedIn()).toEqual([]);
  });

  test("a PUT on a Superseded entry is refused 409 — history is immutable over HTTP", async () => {
    const onDiskBefore = readFileSync(billingSpecPath(), "utf8");
    const res = await app.request("/api/requirements/BILLING-001", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ statement: "Rewriting history." }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("history");
    expect(readFileSync(billingSpecPath(), "utf8")).toBe(onDiskBefore);
  });

  test("a PUT changing a released requirement's statement is refused 409 — supersede instead", async () => {
    commitAndTag(platformDir, "v1.0.0");
    const onDiskBefore = readFileSync(billingSpecPath(), "utf8");
    const res = await app.request("/api/requirements/BILLING-002", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ statement: "Editing a shipped requirement in place." }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("supersede");
    expect(readFileSync(billingSpecPath(), "utf8")).toBe(onDiskBefore);
  });

  test("a PUT with no amendable field returns 400 and does not mutate", async () => {
    const before = readFileSync(billingSpecPath(), "utf8");
    const res = await app.request("/api/requirements/BILLING-002", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(readFileSync(billingSpecPath(), "utf8")).toBe(before);
  });

  test("a PUT for an unknown id returns 404", async () => {
    const res = await app.request("/api/requirements/BILLING-999", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ statement: "nope" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("parity: an invalid create returns byte-identical INVALID_DOMAIN_FILE diagnostics", () => {
  test("an empty statement is rejected 400 with diagnostics deep-equal to a direct validateDomainFile call", async () => {
    const relFile = "spec-engine/BILLING/SPEC.json";

    // Replicate exactly the envelope the route builds for this invalid POST.
    const domain = readBilling();
    const id = await nextRequirementId(platformDir, "BILLING");
    domain.requirements.push({
      id,
      status: "active",
      statement: "",
      why: null,
      supersedes: null,
      supersededBy: null,
      relates: [],
      livesIn: [],
      issues: [],
    });
    domain.updated = localToday();
    const direct = validateDomainFile(domain, relFile);
    expect(direct.ok).toBe(false);

    const onDiskBefore = readFileSync(billingSpecPath(), "utf8");
    const res = await app.request("/api/requirements", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "BILLING", statement: "", why: null }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; diagnostics: unknown[] };
    expect(body.error).toBe("INVALID_DOMAIN_FILE");
    if (!direct.ok) {
      expect(body.diagnostics).toEqual(direct.diagnostics);
    }
    expect(readFileSync(billingSpecPath(), "utf8")).toBe(onDiskBefore);
  });
});

describe("cross-origin — a mismatched Origin is rejected 403 with no mutation", () => {
  test("a POST with a cross-origin Origin header is rejected 403 and does not mutate the SPEC.json", async () => {
    const onDiskBefore = readFileSync(billingSpecPath(), "utf8");
    const res = await app.request("/api/requirements", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Origin: "http://evil.example",
      },
      body: JSON.stringify({
        key: "BILLING",
        statement: "Injected via a cross-site form post.",
        why: "attacker",
      }),
    });
    expect(res.status).toBe(403);
    expect(readFileSync(billingSpecPath(), "utf8")).toBe(onDiskBefore);
  });

  test("a POST with no Origin header (the in-process app.request case) succeeds", async () => {
    const res = await app.request("/api/requirements", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        key: "BILLING",
        statement: "In-process forwarding still writes.",
      }),
    });
    expect(res.status).toBe(201);
  });
});

describe("write-path races + malformed-file handling", () => {
  test("concurrent POSTs mint DISTINCT ids (in-process write mutex)", async () => {
    const posts = Array.from({ length: 6 }, () =>
      app.request("/api/requirements", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: "BILLING", statement: "Concurrent create." }),
      }),
    );
    const resps = await Promise.all(posts);
    expect(resps.every((r) => r.status === 201)).toBe(true);
    const ids = await Promise.all(resps.map((r) => r.json().then((b) => (b as { id: string }).id)));
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("a malformed SPEC.json makes PUT return a structured INVALID_DOMAIN_FILE 400, not a 500", async () => {
    copyFileSync(NOT_JSON_SPEC, billingSpecPath());
    const res = await app.request("/api/requirements/BILLING-002", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ statement: "Tries to amend into a broken file." }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("INVALID_DOMAIN_FILE");
  });
});

describe("DNS-rebinding — a non-loopback Host is rejected 403 even when Origin matches", () => {
  test("a POST whose own Host is a rebound attacker domain is rejected 403 with no mutation", async () => {
    // The rebind: an attacker page on evil.example (DNS → 127.0.0.1) posts to
    // its own origin, so Origin and Host AGREE — the same-origin check alone
    // would pass. The Host pin catches it because evil.example is not loopback.
    const onDiskBefore = readFileSync(billingSpecPath(), "utf8");
    const res = await app.request("http://evil.example/api/requirements", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Origin: "http://evil.example",
      },
      body: JSON.stringify({
        key: "BILLING",
        statement: "Injected via DNS rebinding.",
        why: "attacker",
      }),
    });
    expect(res.status).toBe(403);
    expect(readFileSync(billingSpecPath(), "utf8")).toBe(onDiskBefore);
  });

  test("a PUT whose own Host is a rebound attacker domain is rejected 403 with no mutation", async () => {
    const onDiskBefore = readFileSync(billingSpecPath(), "utf8");
    const first = readBilling().requirements[0] as { id: string };
    const res = await app.request(`http://evil.example/api/requirements/${first.id}`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        Origin: "http://evil.example",
      },
      body: JSON.stringify({ statement: "Tampered via DNS rebinding." }),
    });
    expect(res.status).toBe(403);
    expect(readFileSync(billingSpecPath(), "utf8")).toBe(onDiskBefore);
  });

  test("a POST to a loopback Host with a port and matching Origin still succeeds", async () => {
    const res = await app.request("http://127.0.0.1:7777/api/requirements", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Origin: "http://127.0.0.1:7777",
      },
      body: JSON.stringify({
        key: "BILLING",
        statement: "A genuine loopback write on a non-default port succeeds.",
      }),
    });
    expect(res.status).toBe(201);
  });
});

describe("the Host pin on a --host bind accepts exactly the bound address", () => {
  const LAN = "192.168.0.10";
  const post = (target: typeof app) =>
    target.request(`http://${LAN}:4400/api/requirements`, {
      method: "POST",
      headers: { "content-type": "application/json", Origin: `http://${LAN}:4400` },
      body: JSON.stringify({ key: "BILLING", statement: "A write on the bound LAN address." }),
    });

  test("a write whose Host is the bound address succeeds", async () => {
    // @spec SERV-024 integration
    expect((await post(composeServeApp(storage, platformDir, LAN))).status).toBe(201);
  });

  test("the same Host is a rebind when the server is bound to loopback", async () => {
    // @spec SERV-024 integration
    expect((await post(app)).status).toBe(403);
  });
});

describe("a write whose reindex refuses on another invalid domain file", () => {
  const MISSING_ID_SPEC = join(
    import.meta.dir,
    "..",
    "testing",
    "fixtures",
    "diagnostics",
    "missing-id",
    "spec-engine",
    "BILLING",
    "SPEC.json",
  );

  // @spec SERV-027 unit
  test("POST /api/requirements answers 422 invalid_domain_file with the check --json rows", async () => {
    const fx = TestPlatform.temp("spec-api-422-");
    const fxStorage = openStorage(join(fx.dir, ".spec-engine", "test-index.sqlite"));
    try {
      await fx.domain("ORDERS");
      await fx.domain("BILLING");
      copyFileSync(MISSING_ID_SPEC, join(fx.dir, "spec-engine", "BILLING", "SPEC.json"));
      const res = await composeServeApp(fxStorage, fx.dir).request("/api/requirements", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: "ORDERS", statement: "The system shall ship orders." }),
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: string; diagnostics: Diagnostic[] };
      expect(body.error).toBe("invalid_domain_file");
      expect(body.diagnostics.length).toBeGreaterThan(0);
      for (const row of body.diagnostics) {
        expect(row.code).toBe(DiagnosticCode.INVALID_DOMAIN_FILE);
        expect(row.source_file).toBe("spec-engine/BILLING/SPEC.json");
      }
      expect(JSON.stringify(body.diagnostics)).toBe(renderDiagnostics(body.diagnostics, "json"));
    } finally {
      fxStorage.close();
      fx.remove();
    }
  });
});
