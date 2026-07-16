// packages/shared/src/indexResult.ts
//
// The PARS-05 Rust-swap seam. `IndexResult` is the typed return shape of
// `runIndex()` (implemented in plan 02-05 inside `packages/engine/src/indexer`)
// and is consumed by the `spec index` CLI to print build_id + row counts.
//
// This module is TYPE-ONLY. No runtime imports, no value-level constants,
// no fs / bun:sqlite / Bun.* references. `@spec-engine/shared` avoids runtime
// engine dependencies (V5 / WORK-02, Biome-enforced via noRestrictedImports).
// The ONE sanctioned runtime touchpoint is `domain.ts`'s `validateAndWrite`,
// which uses `Bun.write` to own the single spec-file write seam (VAL-01) — a
// deliberate, documented exception, not a claim this whole package is
// side-effect-free.

export interface IndexResult {
  build_id: string;
  repos: number;
  domains: number;
  requirements: number;
  tags: number;
  diagnostics: number;
}
