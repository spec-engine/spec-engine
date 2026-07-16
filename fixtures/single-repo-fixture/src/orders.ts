// Single-repo "rung 1" fixture: specs live inline under spec-engine/ and the
// code that satisfies them is tagged right here in the SAME repo, in a normal
// `src/` subdir (a realistic layout — NOT loose at the platform root). The repo
// has no sibling member dirs and no spec-engine.member.json; discoverRepos
// registers the repo root itself as the lone self-member and scans this whole
// tree (excluding the in-repo spec-engine/ folder).
//
// Kind is PATH-derived: this path does not match any TEST_MATCH substring, so
// both tags below resolve to `implements`. The bare requirement id is the whole
// tag; never write the words implements/verifies in a @spec tag.

// @spec ORDERS-001
export function placeOrder(): void {
  // reserve inventory + create pending order record
}

// @spec ORDERS-002
export function confirmOrder(): void {
  // transition to confirmed + emit order-confirmed event
}

// ORDERS-003 is intentionally left untagged — it drives an ORPHAN_REQ
// diagnostic. Per CLAUDE.md "keep the planted mess in fixtures", do NOT add
// a tag to silence it.
export function cancelOrder(): void {
  // (no @spec tag on purpose — planted ORPHAN_REQ)
}
