# @spec-engine/site

The docs site — [Astro](https://astro.build) + Starlight, published at
**https://docs.spec-engine.dev**. Content lives in `src/content/docs/`.

```bash
bun run build:site                      # from the repo root (CI runs this)
bun --filter @spec-engine/site dev      # local dev server
```

## Deploy pipeline (RED-90)

**Host: GitHub Pages**, deployed by `.github/workflows/deploy-docs.yml` on
every merge to `main` that touches `packages/site/`. Chosen over Cloudflare
Pages / Netlify because it needs zero external accounts or API-token
secrets: the whole pipeline is checkout → `bun run build:site` →
`actions/deploy-pages`, and the custom domain rides the committed
`public/CNAME` (Astro copies `public/` into `dist/` verbatim, so every
deploy re-asserts `docs.spec-engine.dev`).

**The pipeline is gated** behind the repository variable `DEPLOY_DOCS`
because GitHub Pages serves free only from public repos and this repo is
private until launch (M3). Until the variable is set, pushes to `main`
skip the workflow entirely — nothing goes red.

### One-time human setup (at M3, after the repo goes public)

1. Settings → Pages → Source: **GitHub Actions**.
2. Settings → Secrets and variables → Actions → Variables: add
   `DEPLOY_DOCS` = `true`.
3. DNS: `CNAME docs.spec-engine.dev → spec-engine.github.io`, then enter
   `docs.spec-engine.dev` under Settings → Pages → Custom domain and
   enable **Enforce HTTPS** once the cert issues.
4. DNS: confirm `specengine.dev` redirects to `spec-engine.dev`. The apex
   `spec-engine.dev` stays reserved for the future marketing site — the
   docs site must never squat it.
5. Run the workflow once by hand (Actions → deploy-docs → Run workflow)
   or push any site change to `main`.

### PR previews

Deliberately skipped (RED-90 AC3 was a nice-to-have): GitHub Pages has no
native per-PR previews, and simulating them costs more than they're worth.
`bun --filter @spec-engine/site dev` is the review loop; revisit only if
the site ever moves to a host with built-in previews.
