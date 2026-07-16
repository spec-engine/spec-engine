// Planted fixture for RED-15 doc-binding tests. DOCS-001 is implemented
// here and verified in test/feature.test.ts. DOCS-003 and DOCS-004 are
// deliberately NOT tagged in any code file — DOCS-003 drives ORPHAN_REQ
// despite its prose mention in docs/guide.md, and DOCS-004 drives
// ORPHAN_REQ despite its doc-only `<!-- @spec -->` binding (documents-kind
// tags must never suppress orphan detection). Per CLAUDE.md: keep the
// planted mess — do not tag them to make `spec check` pass.

// @spec DOCS-001
export function renderGuides(): void {
  // markdown -> html at build time
}
