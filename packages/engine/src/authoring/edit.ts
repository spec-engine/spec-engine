// packages/engine/src/authoring/edit.ts
//
// L2/L3 (lifecycle pass) — shared authoring helpers.
//
// As of 17-05 the retired Markdown text-edit helpers (entry lookup, heading
// status flip, field-line replace, and the frontmatter version/updated bumps)
// are DELETED: `spec amend` and `spec supersede` now mutate the domain
// OBJECT and write JSON through the single `validateAndWrite` seam (VAL-01),
// so those helpers have no remaining caller (Phase 18 removes the Markdown
// parser entirely).
//
// `localToday()` remains — it is the shared LOCAL-timezone date source for
// `req` / `amend` / `supersede`. No I/O, no bun:sqlite (the authoring path
// stays index-free; commands do the read/write).

/**
 * Today's date in the LOCAL timezone (WR-05 / AUTHC-004: NEVER toISOString,
 * which rolls the date forward at UTC midnight). Shared by req / supersede /
 * amend for the envelope `updated` field.
 */
export function localToday(): string {
  const d = new Date();
  return (
    `${d.getFullYear()}-` +
    `${String(d.getMonth() + 1).padStart(2, "0")}-` +
    `${String(d.getDate()).padStart(2, "0")}`
  );
}
