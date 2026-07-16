// packages/webapp/test/pages.test.ts
//
// Plan 05-04 / Task 2 — lock SERV-02 at the SSR surface. The 4 page
// handlers from `packages/webapp/src/pages/*.ts` are exercised end-to-end
// via Hono's in-process `app.request()` (Pattern 6 from 05-RESEARCH; no
// Bun.serve port bind, no async cleanup beyond storage.close + tmpdir rm).
//
// TEST-ONLY engine imports — production webapp source is hermetic
// (enforced by `packages/webapp/biome.json`'s scoped `src/**/*.ts`
// override + the defense-in-depth grep test in `import-fence.test.ts`).
// The biome config explicitly carves tests out so this file can import
// `@spec-engine/spec-check` to compose `mountApi(app, storage) + mountWebapp(app)`
// on one Hono instance — mirrors plan 05-05's `commands/serve.ts`
// composition.
//
// Harness mirrors `packages/engine/test/server-api.test.ts`:
//   cloneFixture → openStorage → runIndex once in beforeAll; teardown
//   closes storage + rm tmpdir. The shared storage is safe because every
//   route under test is read-only.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Storage } from "@spec-engine/shared";
import { runIndex } from "@spec-engine/spec-check/src/indexer/pipeline";
import { mountApi } from "@spec-engine/spec-check/src/server/api";
import { openStorage } from "@spec-engine/spec-check/src/storage/sqlite";
import { Hono } from "hono";
import { mountProvenance } from "../src/pages/provenance";
import { mountWebapp } from "../src/server";
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

/** Build a fresh Hono app with `mountApi` + `mountWebapp` composed on it. */
function buildApp(): Hono {
  const app = new Hono();
  mountApi(app, storage);
  mountWebapp(app);
  return app;
}

describe("mountWebapp (SSR pages)", () => {
  // --- GET / (coverage matrix) ----------------------------------------------

  test("GET / → 200 HTML with <h1>Coverage matrix</h1> + BILLING-009 row", async () => {
    const app = buildApp();
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<h1>Coverage matrix</h1>");
    expect(body).toContain("BILLING-009");
    expect(body).toContain("<tr>");
    // Sanity: the page should be a self-contained document.
    expect(body.toLowerCase()).toContain("<!doctype html>");
  });

  // --- GET /requirements (list) ---------------------------------------------

  test("GET /requirements → 200 HTML listing all 5 fixture requirements", async () => {
    const app = buildApp();
    const res = await app.request("/requirements");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<h1>Requirements</h1>");
    // 5 fixture rows: AUTH-001 + BILLING-001/002/007/009
    for (const id of ["AUTH-001", "BILLING-001", "BILLING-002", "BILLING-007", "BILLING-009"]) {
      expect(body).toContain(id);
    }
    // Each requirement row is still a real link (no-JS fallback to the detail
    // page + progressive enhancement into the side panel).
    expect(body).toContain('href="/requirements/BILLING-009"');
  });

  // --- GET /requirements (domain accordion + side panel) --------------------

  test("GET /requirements → domain accordion, detail panels, and the typed toggle script", async () => {
    const app = buildApp();
    const res = await app.request("/requirements");
    expect(res.status).toBe(200);
    const body = await res.text();
    // Collapsible accordion: a <details> card per domain with a summary header
    // naming the domain key.
    expect(body).toContain('<details class="domain-card">');
    expect(body).toContain('class="domain-summary"');
    expect(body).toContain(">BILLING<"); // domain key rendered in the summary
    // A server-rendered detail panel exists per requirement (hidden until
    // selected — all collapsed on load, so none of the <details> is `open`).
    expect(body).toContain('id="panel-BILLING-009"');
    expect(body).not.toContain('<details class="domain-card" open');
    // The interactivity is the permitted typed-module form, never a bare
    // <script> (that guard is asserted separately below).
    expect(body).toContain('<script type="module">');
    expect(body).toContain("expand-all");
    expect(body).toContain(">Expand all<");
  });

  // --- GET /requirements/:id (detail happy path) ----------------------------

  test("GET /requirements/BILLING-009 → 200 HTML with <h1>BILLING-009</h1> + 'renew'", async () => {
    const app = buildApp();
    const res = await app.request("/requirements/BILLING-009");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<h1>BILLING-009</h1>");
    // The fixture text mentions "renews"/"renew" — lowercase substring guard
    // tolerates either capitalization.
    expect(body.toLowerCase()).toContain("renew");
  });

  // --- GET /requirements/:id (404) ------------------------------------------

  test("GET /requirements/NOPE-404 → 200 HTML 'Requirement not found' page", async () => {
    const app = buildApp();
    const res = await app.request("/requirements/NOPE-404");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Requirement not found");
    expect(body).toContain("NOPE-404");
  });

  // --- GET /propagation/:id -------------------------------------------------

  test("GET /propagation/BILLING-009 → 200 HTML with all 3 member states", async () => {
    const app = buildApp();
    const res = await app.request("/propagation/BILLING-009");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<h1>Propagation: BILLING-009</h1>");
    // All 3 member-repo states present (admin/api/mobile).
    expect(body).toContain("MIGRATED_VERIFIED"); // api
    expect(body).toContain("ON_PREDECESSOR"); // mobile
    expect(body).toContain("ON_OTHER_DOMAIN_REQ"); // admin
  });

  // --- GET /query — feature disabled ("coming soon") ------------------------
  // The FTS search UI is flag-gated off (QUERY_ENABLED=false in
  // src/pages/query.ts). The route stays mounted and renders a coming-soon
  // placeholder (not a 404); the parked search implementation + its FTS /
  // error-path tests return when the flag flips back to true.

  test("GET /query → 200 coming-soon placeholder (feature disabled)", async () => {
    const app = buildApp();
    const res = await app.request("/query");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<h1>Query</h1>");
    expect(body).toContain("Coming soon");
    // No search form is rendered and no FTS runs while disabled. (Substring
    // `<input` never appears in the embedded CSS, unlike `name="q"`.)
    expect(body).not.toContain("<input");
    expect(body).not.toContain('href="/requirements/BILLING');
  });

  test("GET /query?q=… does not reflect the query string while disabled", async () => {
    // Even disabled, the route must never echo attacker-controlled `q`.
    const app = buildApp();
    const res = await app.request("/query?q=%3Cb%3Erenewal");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain("<b>");
    expect(body).not.toContain("&lt;b&gt;");
    expect(body).not.toContain("renewal");
  });

  // --- XSS auto-escape sanity ----------------------------------------------

  test("XSS sanity: no <script> tags injected into rendered output", async () => {
    // Positive control: nothing in the fixture or in our handlers should
    // ever produce an inline <script> tag. If a future regression causes
    // a `raw()` call to leak user data, this guard fails. (Specific
    // <script> probe is appropriate because hono/html escapes `<` to
    // `&lt;` — any literal `<script>` in the body means raw HTML was
    // injected without escaping.)
    const app = buildApp();
    for (const path of ["/", "/requirements", "/requirements/BILLING-009", "/query?q=renewal"]) {
      const res = await app.request(path);
      const body = await res.text();
      expect(body).not.toContain("<script>");
    }
  });

  // --- GET /provenance — feature disabled ("coming soon") ------------------
  // /provenance is flag-gated off (PROVENANCE_ENABLED=false) → coming-soon
  // placeholder. The resolved-title XSS-escaping test below is parked
  // (test.skip) and returns when the flag flips back to true.
  test("GET /provenance → 200 coming-soon placeholder (feature disabled)", async () => {
    const app = buildApp();
    const res = await app.request("/provenance");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<h1>Provenance matrix</h1>");
    expect(body).toContain("Coming soon");
    expect(body).not.toContain("<pre");
  });

  // --- /provenance resolved title/url XSS escaping (PWEB-03 / T-16-XSS) -----
  // PARKED while PROVENANCE_ENABLED=false. The escaping logic still lives
  // behind the flag; unskip when the route is re-enabled.

  test.skip("XSS: a resolved title/url containing <script>/quotes is HTML-escaped on /provenance", async () => {
    // PWEB-03 / T-16-XSS: resolved Linear `title`/`url` strings are
    // attacker-influenceable and flow into the decorated text the page
    // renders. They MUST be HTML-escaped by hono/html — never emitted as raw
    // markup. We drive the REAL page path: mountProvenance reads
    // `/api/provenance` (JSON, non-empty → renders) then
    // `/api/provenance?resolve=1` (the DECORATED TEXT seam). Stub both routes
    // on a fresh app so the decorated text carries a malicious resolved title.
    const app = new Hono();
    const MALICIOUS_TITLE = '<script>alert("xss")</script>';
    const MALICIOUS_URL = 'https://linear.app/"><script>steal()</script>';
    // Stub the engine seam: JSON projection is non-empty (so the page renders
    // the matrix branch), and the ?resolve=1 text carries the attacker title.
    app.get("/api/provenance", (c) => {
      if (c.req.query("resolve") === "1") {
        return c.text(
          `BILLING-009  [Active]  tests: src\n  created  ENG-1432  ${MALICIOUS_TITLE}  ${MALICIOUS_URL}\n`,
        );
      }
      return c.json([{ req_id: "BILLING-009", issue_id: "ENG-1432" }]);
    });
    mountProvenance(app);

    const res = await app.request("/provenance");
    expect(res.status).toBe(200);
    const body = await res.text();
    // The page DID render the decorated text (the bare id survives, escaped
    // text is present) — proves we exercised the matrix branch, not empty-state.
    expect(body).toContain("ENG-1432");
    // The malicious markup MUST be escaped — no bare <script> tag in the body.
    expect(body).not.toContain("<script>");
    expect(body).not.toContain("</script>");
    // The escaped form must be present, proving the title flowed through the
    // auto-escaping tagged template rather than being dropped.
    expect(body).toContain("&lt;script&gt;");
  });

  // --- GET /relations (empty state — platform-fixture has no Relates) -------

  // /relations is flag-gated off (RELATIONS_ENABLED=false) → coming-soon
  // placeholder. The populated-graph render tests are parked in a
  // describe.skip below and return when the flag flips back to true.
  test("GET /relations → 200 coming-soon placeholder (feature disabled)", async () => {
    const app = buildApp();
    const res = await app.request("/relations");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<h1>Relates graph</h1>");
    expect(body).toContain("Coming soon");
    // Disabled state must NOT ship the mermaid render path.
    expect(body).not.toContain('class="mermaid"');
    expect(body).not.toContain("<script");
  });

  // --- GET /setup (System → Setup) ------------------------------------------

  test("GET /setup → 200 HTML with the mapped-repositories view", async () => {
    const app = buildApp();
    const res = await app.request("/setup");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("How Spec Engine reads your code");
    expect(body).toContain("Mapped members");
    // The canonical spec store is the requirement manifest, never a member —
    // it must not render as a mapped row (its numbers are structurally 0).
    expect(body).not.toContain('<span class="spec-id">spec-engine</span>');
    // Every listed member repo is MAPPED, and the scan mode is detected.
    expect(body).toContain("MAPPED");
    expect(body).toContain("Scan mode");
  });

  // --- GET /logs (System → Logs, coming soon) -------------------------------

  test("GET /logs → 200 coming-soon placeholder (feature disabled)", async () => {
    const app = buildApp();
    const res = await app.request("/logs");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<h1>Logs</h1>");
    expect(body).toContain("Coming soon");
  });
});

// ---------------------------------------------------------------------------
// RED-17: /relations diagram path — needs the relates-fixture (the main
// platform-fixture deliberately has no Relates fields, so the populated
// graph is exercised against its own clone + storage here).
//
// PARKED while RELATIONS_ENABLED=false (the /relations route renders the
// coming-soon placeholder). The mermaid-render implementation still lives
// behind the flag; unskip this block when the route is re-enabled.
// ---------------------------------------------------------------------------

describe.skip("GET /relations — populated graph (relates-fixture)", () => {
  const RELATES_FIXTURE = resolve(import.meta.dir, "..", "..", "..", "fixtures", "relates-fixture");

  let relClone: string;
  let relStorage: Storage;

  beforeAll(async () => {
    relClone = cloneFixture(RELATES_FIXTURE);
    // Strip any stale committed-index leftovers — the index is rebuilt
    // fresh from the cloned spec (the derived DB owns nothing).
    rmSync(join(relClone, ".spec-engine"), { recursive: true, force: true });
    relStorage = openStorage(join(relClone, ".spec-engine", "index.sqlite"));
    await runIndex({ platformDir: relClone, storage: relStorage });
  });

  afterAll(() => {
    relStorage.close();
    rmSync(relClone, { recursive: true, force: true });
  });

  function buildRelApp(): Hono {
    const app = new Hono();
    mountApi(app, relStorage);
    mountWebapp(app);
    return app;
  }

  test('renders the mermaid source in <pre class="mermaid"> with the client render script', async () => {
    const app = buildRelApp();
    const res = await app.request("/relations");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<h1>Relates graph</h1>");
    expect(body).toContain('<pre class="mermaid">');
    // The mermaid text flows through the auto-escaping tagged template —
    // quotes inside node labels arrive entity-escaped, which the browser
    // parses back to literal quotes in the element's text content.
    expect(body).toContain("graph LR");
    expect(body).toContain("REL_001[&quot;REL-001&quot;]");
    expect(body).toContain("REL_001 --- REL_003");
    expect(body).toContain("REL_003 --- REL_999");
    // Client-side renderer: a module script importing mermaid. The bare
    // `<script>` form stays banned (XSS guard above) — only the typed
    // module tag is allowed, and only on this page.
    expect(body).toContain('<script type="module">');
    expect(body).toContain("mermaid");
    expect(body).not.toContain("<script>");
  });

  test("empty-state message does NOT appear when the graph is populated", async () => {
    const app = buildRelApp();
    const res = await app.request("/relations");
    const body = await res.text();
    expect(body).not.toContain("No Relates links indexed");
  });
});

// ----------------------------------------------------------------------------
// The /report SSR page is RETIRED — its visuals were absorbed into the
// Coverage matrix (health stats row + domain-row heat chips). The
// /api/report route and MCP spec_coverage_report tool are unchanged.
// ----------------------------------------------------------------------------

describe("GET /report (page retired)", () => {
  test("→ 404 (no route); nav carries no report link; /api/report still serves", async () => {
    const app = buildApp();
    expect((await app.request("/report")).status).toBe(404);

    const nav = await (await app.request("/")).text();
    expect(nav).not.toContain('href="/report"');

    const api = await app.request("/api/report");
    expect(api.status).toBe(200);
    const rows = (await api.json()) as Array<{ domain: string }>;
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe("shared nav (W4)", () => {
  test("every SSR page carries the nav with a /requirements link", async () => {
    const app = buildApp();
    for (const path of ["/", "/requirements", "/query", "/relations"]) {
      const res = await app.request(path);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain("<nav");
      expect(body).toContain('href="/requirements"');
    }
  });
});

// ---------------------------------------------------------------------------
// RED-93: scan-mode detection on the Setup page. The dogfood monorepo (one
// git repo, workspace packages expanded via a `members` glob) was labeled
// "platform", and a rung-1 single repo was too — the old check was a raw
// repos.length count that included the canonical spec-engine row, and the
// Monorepo tile was hardcoded off. Each shape gets its own tmp platform +
// storage (the shared beforeAll storage stays pinned to platform-fixture).
// ---------------------------------------------------------------------------

// @spec SERV-004 integration
describe("Setup scan-mode detection (RED-93)", () => {
  /** Index `platformDir` into a throwaway storage and serve it. */
  async function appOver(platformDir: string): Promise<{ app: Hono; close: () => void }> {
    const s = openStorage(join(platformDir, ".spec-engine", "index.sqlite"));
    await runIndex({ platformDir, storage: s });
    const app = new Hono();
    mountApi(app, s);
    mountWebapp(app);
    return { app, close: () => s.close() };
  }

  /** Minimal BILLING domain so the platform mounts with one requirement. */
  async function writeSpecDomain(root: string): Promise<void> {
    await mkdir(join(root, "spec-engine", "BILLING"), { recursive: true });
    await writeFile(
      join(root, "spec-engine", "BILLING", "SPEC.json"),
      `${JSON.stringify({
        key: "BILLING",
        owner: null,
        updated: "2026-01-01",
        requirements: [
          { id: "BILLING-001", status: "active", statement: "Charges compute tax at charge time." },
        ],
      })}\n`,
    );
  }

  test("workspace-expanded members (monorepo) light the Monorepo tile, not Platform", async () => {
    const root = mkdtempSync(join(tmpdir(), "spec-setup-monorepo-"));
    try {
      await writeSpecDomain(root);
      // The dogfood shape: one repo, packages/* expanded into sub-members.
      await mkdir(join(root, "packages", "engine", "src"), { recursive: true });
      await mkdir(join(root, "packages", "shared", "src"), { recursive: true });
      await writeFile(
        join(root, "packages", "spec-engine.member.json"),
        `${JSON.stringify({ specs: "spec-engine@1", members: "*" })}\n`,
      );
      await writeFile(join(root, "packages", "engine", "src", "a.ts"), "export const a = 1;\n");
      await writeFile(join(root, "packages", "shared", "src", "b.ts"), "export const b = 2;\n");

      const { app, close } = await appOver(root);
      try {
        const body = await (await app.request("/setup")).text();
        expect(body).toContain("<dt>mode</dt><dd>monorepo</dd>");
      } finally {
        close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rung-1 self-member lights Single repo, not Platform (canonical row must not count)", async () => {
    const single = cloneFixture(
      resolve(import.meta.dir, "..", "..", "..", "fixtures", "single-repo-fixture"),
    );
    try {
      const { app, close } = await appOver(single);
      try {
        const body = await (await app.request("/setup")).text();
        expect(body).toContain("<dt>mode</dt><dd>single</dd>");
      } finally {
        close();
      }
    } finally {
      rmSync(single, { recursive: true, force: true });
    }
  });

  test("true multi-repo platform still reads platform (regression)", async () => {
    const app = buildApp(); // shared platform-fixture storage: api/mobile/admin siblings
    const body = await (await app.request("/setup")).text();
    expect(body).toContain("<dt>mode</dt><dd>platform</dd>");
  });
});

// ---------------------------------------------------------------------------
// RED-99: the live-contract default. Coverage and Requirements hide
// Superseded/Retired rows (and any domain they empty out) unless ?all=1;
// the toggle is a plain link; a listed requirement's version history keeps
// its superseded predecessors in either view. Report needs no toggle — its
// rollup is Active-only by construction (buildCoverageReport), so a fully
// superseded domain never gets a row; the last test pins that.
// ---------------------------------------------------------------------------

// @spec SERV-005 integration
describe("status filtering: live-contract default + ?all=1 toggle (RED-99)", () => {
  test("Coverage: superseded rows hidden by default, shown under ?all=1, toggle link present", async () => {
    const app = buildApp(); // platform-fixture: BILLING-001 is Superseded
    const byDefault = await (await app.request("/")).text();
    expect(byDefault).not.toContain("BILLING-001");
    expect(byDefault).toContain('href="/?all=1"');

    const all = await (await app.request("/?all=1")).text();
    expect(all).toContain("BILLING-001");
    expect(all).toContain('href="/"');
  });

  test("Requirements: superseded reqs not listed by default, but version history keeps them", async () => {
    const app = buildApp();
    const byDefault = await (await app.request("/requirements")).text();
    // Not a listed row…
    expect(byDefault).not.toContain('data-req="BILLING-001"');
    // …but BILLING-009's lineage panel still names its predecessor.
    expect(byDefault).toContain("BILLING-001");
    expect(byDefault).toContain('href="/requirements?all=1"');

    const all = await (await app.request("/requirements?all=1")).text();
    expect(all).toContain('data-req="BILLING-001"');
    expect(all).toContain('href="/requirements"');
  });

  test("a domain left with zero listed reqs hides with them; ?all=1 restores it — Report never shows it", async () => {
    // Two domains: GONE holds only a superseded req (dangling successor is
    // fine — structural, not required to resolve); LIVE holds an active one.
    const root = mkdtempSync(join(tmpdir(), "spec-status-filter-"));
    try {
      const writeDomain = async (key: string, reqs: unknown[]) => {
        await mkdir(join(root, "spec-engine", key), { recursive: true });
        await writeFile(
          join(root, "spec-engine", key, "SPEC.json"),
          `${JSON.stringify({ key, owner: null, updated: "2026-01-01", requirements: reqs })}\n`,
        );
      };
      await writeDomain("GONE", [
        {
          id: "GONE-001",
          status: "superseded",
          statement: "The old promise this domain used to make.",
          // Dangling successor on purpose: pointing at LIVE-001 would put
          // GONE-001 into LIVE-001's version-history panel (the lineage
          // KEEPS predecessors by design), defeating the hidden-domain
          // assertion below.
          supersededBy: "GONE-002",
        },
      ]);
      await writeDomain("LIVE", [
        { id: "LIVE-001", status: "active", statement: "The promise the platform makes now." },
      ]);

      const s = openStorage(join(root, ".spec-engine", "index.sqlite"));
      try {
        await runIndex({ platformDir: root, storage: s });
        const app = new Hono();
        mountApi(app, s);
        mountWebapp(app);

        for (const path of ["/", "/requirements"]) {
          const byDefault = await (await app.request(path)).text();
          expect(byDefault).toContain("LIVE");
          expect(byDefault).not.toContain("GONE-001");
          const all = await (await app.request(`${path}?all=1`)).text();
          expect(all).toContain("GONE-001");
        }

        // The report PAGE is retired; the Active-only rollup contract lives
        // on at the API seam — GONE has no row there, toggle or not.
        const rows = (await (await app.request("/api/report")).json()) as Array<{
          domain: string;
        }>;
        expect(rows.some((r) => r.domain === "LIVE")).toBe(true);
        expect(rows.some((r) => r.domain === "GONE")).toBe(false);
      } finally {
        s.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Coverage absorbs the Report visuals (session follow-on to RED-99): the
// stats row carries the Impl% / Verif% / verify-gap headline (same
// pages/health.ts math as /report — one math, two renderers), and each
// domain header row carries the per-member heat cells (components.heatCell,
// the same renderer /report's grid uses).
// ---------------------------------------------------------------------------

describe("Coverage page: health stats + domain-row heat cells", () => {
  test("stats row shows the /report percentages (platform-fixture: 75% / 50% / 25%)", async () => {
    const app = buildApp(); // fixture: 4 active, 3 implemented, 2 verified
    const body = await (await app.request("/")).text();
    expect(body).toContain('<div class="num">75%</div><div class="label">Implemented</div>');
    expect(body).toContain('<div class="num">50%</div><div class="label">Verified</div>');
    expect(body).toContain('<div class="num">25%</div><div class="label">Verify gap</div>');
  });

  test("domain header rows carry heat cells per member (same renderer as /report)", async () => {
    const app = buildApp();
    const body = await (await app.request("/")).text();
    // The old full-width spanning header cell is gone…
    expect(body).not.toContain('<tr class="domain-row">\n                  <td colspan=');
    // …replaced by heat cubes inside the domain rows — the SAME .glyph cube
    // the requirement rows use, carrying a count — and the rollup moved
    // into the rollup column.
    expect(body).toContain("heat-cell");
    expect(body).toMatch(/class="glyph (none )?heat/);
    expect(body).toContain('title="implemented / verified across members (active reqs only)"');
  });
});

// ---------------------------------------------------------------------------
// The canonical spec-engine row is the requirement manifest, not a member —
// it is never tag-scanned, so any column/row it renders is structurally
// zero. Excluded from every member-facing webapp surface (Setup asserts
// this inline above); the CLI `spec map` contract is unchanged.
// ---------------------------------------------------------------------------

describe("canonical spec store excluded from member surfaces", () => {
  test("Coverage matrix has no spec-engine member column", async () => {
    const app = buildApp();
    const body = await (await app.request("/")).text();
    expect(body).not.toContain('<th class="repo-col">spec-engine</th>');
    expect(body).toContain('<th class="repo-col">api</th>');
  });
});

// ---------------------------------------------------------------------------
// RED-80: Registry → Glossary placeholder. Route mounted, coming-soon doc,
// nav carries the disabled entry (not a link — the real page renders the
// TERM store when it ships).
// ---------------------------------------------------------------------------

describe("GET /glossary (coming soon — RED-80)", () => {
  test("→ 200 coming-soon placeholder and a disabled nav entry", async () => {
    const app = buildApp();
    const res = await app.request("/glossary");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<h1>Glossary</h1>");
    expect(body).toContain("Coming soon");
    // The nav shows Glossary as a disabled coming-soon item, not a link.
    expect(body).not.toContain('href="/glossary"');
    expect(body).toMatch(/Glossary<span class="soon">coming soon<\/span>/);
  });
});
