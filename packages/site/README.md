# @spec-engine/site

The docs site — [Astro](https://astro.build) + Starlight, published at
**https://docs.spec-engine.dev**. Content lives in `src/content/docs/`.

```bash
bun run build:site                      # from the repo root (CI runs this)
bun --filter @spec-engine/site dev      # local dev server
```

## Deploy pipeline

- Host: GitHub Pages, via `.github/workflows/deploy-docs.yml`, on every merge to `main` that touches `packages/site/`.
- Pipeline: checkout, `bun run build:site`, `actions/deploy-pages`. No external accounts or API tokens.
- Custom domain rides the committed `public/CNAME`; Astro copies `public/` into `dist/` verbatim.
- Gated behind the repository variable `DEPLOY_DOCS`. GitHub Pages serves free only from public repos, so until the variable is set, pushes skip the workflow and nothing goes red.

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

None. GitHub Pages has no per-PR previews. `bun --filter @spec-engine/site dev` is the review loop.
