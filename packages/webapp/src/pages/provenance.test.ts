// Tests may import `@spec-engine/spec-engine` (the Biome import fence covers
// production source only) to compose `mountApi` and `mountWebapp` on one Hono
// app, as `commands/serve.ts` does. The shared storage is safe because every
// route under test is read-only.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Storage } from "@spec-engine/shared";
import { runIndex } from "@spec-engine/spec-engine/src/indexer/pipeline";
import { mountApi } from "@spec-engine/spec-engine/src/server/api";
import { openStorage } from "@spec-engine/spec-engine/src/storage/sqlite";
import { entryOf, plantEdit } from "@spec-engine/spec-engine/src/testing/plant";
import { TestPlatform } from "@spec-engine/spec-engine/src/testing/platform";
import { Hono } from "hono";
import { mountWebapp } from "../server";
import { cloneFixture } from "../testing/cloneFixture";
import { mountProvenance } from "./provenance";

const FIXTURE = resolve(import.meta.dir, "..", "..", "..", "..", "fixtures", "platform-fixture");

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

function buildApp(): Hono {
  const app = new Hono();
  mountApi(app, storage, clone);
  mountWebapp(app);
  return app;
}

describe("mountWebapp (SSR pages)", () => {
  test("GET / → 200 HTML with <h1>Coverage matrix</h1> + BILLING-009 row", async () => {
    const app = buildApp();
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<h1>Coverage matrix</h1>");
    expect(body).toContain("BILLING-009");
    expect(body).toContain("<tr>");
    expect(body.toLowerCase()).toContain("<!doctype html>");
  });

  test("GET /requirements → 200 HTML listing all 5 fixture requirements", async () => {
    const app = buildApp();
    const res = await app.request("/requirements");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<h1>Requirements</h1>");
    for (const id of ["AUTH-001", "BILLING-001", "BILLING-002", "BILLING-007", "BILLING-009"]) {
      expect(body).toContain(id);
    }
    // A real link, so the row still reaches the detail page without JS.
    expect(body).toContain('href="/requirements/BILLING-009"');
  });

  test("GET /requirements → domain accordion, detail panels, and the typed toggle script", async () => {
    const app = buildApp();
    const res = await app.request("/requirements");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('<details class="domain-card">');
    expect(body).toContain('class="domain-summary"');
    expect(body).toContain(">BILLING<");
    expect(body).toContain('id="panel-BILLING-009"');
    expect(body).not.toContain('<details class="domain-card" open');
    expect(body).toContain('<script type="module">');
    expect(body).toContain("expand-all");
    expect(body).toContain(">Expand all<");
  });

  test("GET /requirements/BILLING-009 → 200 HTML with <h1>BILLING-009</h1> + 'renew'", async () => {
    const app = buildApp();
    const res = await app.request("/requirements/BILLING-009");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<h1>BILLING-009</h1>");
    expect(body.toLowerCase()).toContain("renew");
  });

  // @spec SCHM-040 unit
  test("GET /requirements/BILLING-009 lists its implementing and verifying sites", async () => {
    const body = await (await buildApp().request("/requirements/BILLING-009")).text();
    expect(body).toContain("<code>api/src/renew.ts:1</code>");
    expect(body).toContain("<code>api/test/renew.e2e.test.ts:1</code>");
  });

  test("GET /requirements/NOPE-404 → 200 HTML 'Requirement not found' page", async () => {
    const app = buildApp();
    const res = await app.request("/requirements/NOPE-404");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Requirement not found");
    expect(body).toContain("NOPE-404");
  });

  test("GET /propagation/BILLING-009 → 200 HTML with all 3 member states", async () => {
    const app = buildApp();
    const res = await app.request("/propagation/BILLING-009");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<h1>Propagation: BILLING-009</h1>");
    expect(body).toContain("MIGRATED_VERIFIED"); // api
    expect(body).toContain("ON_PREDECESSOR"); // mobile
    expect(body).toContain("ON_OTHER_DOMAIN_REQ"); // admin
  });

  test("GET /query → 200 coming-soon placeholder (feature disabled)", async () => {
    const app = buildApp();
    const res = await app.request("/query");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<h1>Query</h1>");
    expect(body).toContain("Coming soon");
    // Probe `<input`, not `name="q"`: only the former never appears in the embedded CSS.
    expect(body).not.toContain("<input");
    expect(body).not.toContain('href="/requirements/BILLING');
  });

  test("GET /query?q=… does not reflect the query string while disabled", async () => {
    const app = buildApp();
    const res = await app.request("/query?q=%3Cb%3Erenewal");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain("<b>");
    expect(body).not.toContain("&lt;b&gt;");
    expect(body).not.toContain("renewal");
  });

  test("XSS sanity: no <script> tags injected into rendered output", async () => {
    // hono/html escapes `<`, so a literal bare `<script>` means a `raw()` call
    // leaked unescaped data.
    const app = buildApp();
    for (const path of ["/", "/requirements", "/requirements/BILLING-009", "/query?q=renewal"]) {
      const res = await app.request(path);
      const body = await res.text();
      expect(body).not.toContain("<script>");
    }
  });

  test("GET /provenance → 200 coming-soon placeholder (feature disabled)", async () => {
    const app = buildApp();
    const res = await app.request("/provenance");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<h1>Provenance matrix</h1>");
    expect(body).toContain("Coming soon");
    expect(body).not.toContain("<pre");
  });

  // Skipped while the provenance flag is off by default; the route renders the
  // placeholder until SPEC_FLAGS enables it.
  test.skip("XSS: a resolved title/url containing <script>/quotes is HTML-escaped on /provenance", async () => {
    const app = new Hono();
    const MALICIOUS_TITLE = '<script>alert("xss")</script>';
    const MALICIOUS_URL = 'https://linear.app/"><script>steal()</script>';
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
    // The id proves the matrix branch rendered, not the empty state.
    expect(body).toContain("ENG-1432");
    expect(body).not.toContain("<script>");
    expect(body).not.toContain("</script>");
    // The escaped form proves the title was escaped, not dropped.
    expect(body).toContain("&lt;script&gt;");
  });

  test("GET /relations → 200 coming-soon placeholder (feature disabled)", async () => {
    const app = buildApp();
    const res = await app.request("/relations");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<h1>Relates graph</h1>");
    expect(body).toContain("Coming soon");
    expect(body).not.toContain('class="mermaid"');
    expect(body).not.toContain("<script");
  });

  test("GET /setup → 200 HTML with the mapped-repositories view", async () => {
    const app = buildApp();
    const res = await app.request("/setup");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("How Spec Engine reads your code");
    expect(body).toContain("Mapped members");
    expect(body).not.toContain('<span class="spec-id">spec-engine</span>');
    expect(body).toContain("MAPPED");
    expect(body).toContain("Scan mode");
  });

  test("GET /logs → 200 coming-soon placeholder (feature disabled)", async () => {
    const app = buildApp();
    const res = await app.request("/logs");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<h1>Logs</h1>");
    expect(body).toContain("Coming soon");
  });
});

// platform-fixture deliberately has no Relates fields, so the populated graph
// needs its own fixture. Skipped while the relations flag is off by default.
describe.skip("GET /relations — populated graph (relates-fixture)", () => {
  const RELATES_FIXTURE = resolve(
    import.meta.dir,
    "..",
    "..",
    "..",
    "..",
    "fixtures",
    "relates-fixture",
  );

  let relClone: string;
  let relStorage: Storage;

  beforeAll(async () => {
    relClone = cloneFixture(RELATES_FIXTURE);
    // A committed index left in the fixture would be stale.
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
    mountApi(app, relStorage, relClone);
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
    expect(body).toContain("graph LR");
    expect(body).toContain("REL_001[&quot;REL-001&quot;]");
    expect(body).toContain("REL_001 --- REL_003");
    expect(body).toContain("REL_003 --- REL_999");
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

describe("shared nav", () => {
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

// @spec SERV-018 integration
describe("Setup scan-mode detection", () => {
  async function appOver(platformDir: string): Promise<{ app: Hono; close: () => void }> {
    const s = openStorage(join(platformDir, ".spec-engine", "index.sqlite"));
    await runIndex({ platformDir, storage: s });
    const app = new Hono();
    mountApi(app, s, platformDir);
    mountWebapp(app);
    return { app, close: () => s.close() };
  }

  async function writeSpecDomain(root: string): Promise<void> {
    const billing = await TestPlatform.at(root).domain("BILLING");
    await billing.req({ statement: "Charges compute tax at charge time." });
  }

  test("a lone monorepo lights the Monorepo tile, not Platform", async () => {
    const root = mkdtempSync(join(tmpdir(), "spec-setup-monorepo-"));
    try {
      await writeSpecDomain(root);
      const fx = TestPlatform.at(root);
      fx.workspace(["packages/engine", "packages/shared"]);
      fx.file("packages/engine/src/a.ts", "export const a = 1;\n");
      fx.file("packages/shared/src/b.ts", "export const b = 2;\n");

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
      resolve(import.meta.dir, "..", "..", "..", "..", "fixtures", "single-repo-fixture"),
    );
    try {
      const { app, close } = await appOver(single);
      try {
        const body = await (await app.request("/setup")).text();
        expect(body).toContain("<dt>mode</dt><dd>single-repo</dd>");
      } finally {
        close();
      }
    } finally {
      rmSync(single, { recursive: true, force: true });
    }
  });

  test("a multi-repo platform reads multi-repo", async () => {
    const app = buildApp(); // shared platform-fixture storage: api/mobile/admin siblings
    const body = await (await app.request("/setup")).text();
    expect(body).toContain("<dt>mode</dt><dd>multi-repo</dd>");
  });
});

// @spec SERV-014 integration
// @spec SERV-016 integration
// @spec SERV-015 integration
describe("status filtering: live-contract default + ?all=1 toggle", () => {
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
    expect(byDefault).not.toContain('data-req="BILLING-001"');
    // BILLING-009's lineage panel still names its predecessor.
    expect(byDefault).toContain("BILLING-001");
    expect(byDefault).toContain('href="/requirements?all=1"');

    const all = await (await app.request("/requirements?all=1")).text();
    expect(all).toContain('data-req="BILLING-001"');
    expect(all).toContain('href="/requirements"');
  });

  test("a domain left with zero listed reqs hides with them; ?all=1 restores it — Report never shows it", async () => {
    const root = mkdtempSync(join(tmpdir(), "spec-status-filter-"));
    try {
      const fx = TestPlatform.at(root);
      const gone = await fx.domain("GONE");
      const old = await gone.req({ statement: "The old promise this domain made." });
      // Dangling successor on purpose: pointing at LIVE-001 would put GONE-001
      // into LIVE-001's version-history panel (the lineage KEEPS predecessors
      // by design), defeating the hidden-domain assertion below. No operation
      // supersedes into a successor that does not exist, so it is planted.
      await plantEdit(root, "GONE", (doc) => {
        const entry = entryOf(doc, old.id);
        entry.status = "superseded";
        entry.supersededBy = "GONE-002";
      });
      const live = await fx.domain("LIVE");
      await live.req({ statement: "The promise the platform makes now." });

      const s = openStorage(join(root, ".spec-engine", "index.sqlite"));
      try {
        await runIndex({ platformDir: root, storage: s });
        const app = new Hono();
        mountApi(app, s, root);
        mountWebapp(app);

        for (const path of ["/", "/requirements"]) {
          const byDefault = await (await app.request(path)).text();
          expect(byDefault).toContain("LIVE");
          expect(byDefault).not.toContain("GONE-001");
          const all = await (await app.request(`${path}?all=1`)).text();
          expect(all).toContain("GONE-001");
        }

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

describe("Coverage page: health stats + domain-row heat cells", () => {
  test("stats row shows the health percentages (platform-fixture: 75% / 50% / 25%)", async () => {
    const app = buildApp(); // fixture: 4 active, 3 implemented, 2 verified
    const body = await (await app.request("/")).text();
    expect(body).toContain('<div class="num">75%</div><div class="label">Implemented</div>');
    expect(body).toContain('<div class="num">50%</div><div class="label">Verified</div>');
    expect(body).toContain('<div class="num">25%</div><div class="label">Verify gap</div>');
  });

  test("domain header rows carry heat cells per member", async () => {
    const app = buildApp();
    const body = await (await app.request("/")).text();
    expect(body).not.toContain('<tr class="domain-row">\n                  <td colspan=');
    expect(body).toContain("heat-cell");
    expect(body).toMatch(/class="glyph (none )?heat/);
    expect(body).toContain('title="implemented / verified across members (active reqs only)"');
  });
});

describe("canonical spec store excluded from member surfaces", () => {
  test("Coverage matrix has no spec-engine member column", async () => {
    const app = buildApp();
    const body = await (await app.request("/")).text();
    expect(body).not.toContain('<th class="repo-col">spec-engine</th>');
    expect(body).toContain('<th class="repo-col">api</th>');
  });
});

describe("GET /glossary (coming soon)", () => {
  test("→ 200 coming-soon placeholder and a disabled nav entry", async () => {
    const app = buildApp();
    const res = await app.request("/glossary");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<h1>Glossary</h1>");
    expect(body).toContain("Coming soon");
    expect(body).not.toContain('href="/glossary"');
    expect(body).toMatch(/Glossary<span class="soon">coming soon<\/span>/);
  });
});
