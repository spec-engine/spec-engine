// Planted fixture for RED-16 Relates-field tests. REL-001 and REL-003 are
// implemented here and verified in test/app.test.ts so the ONLY diagnostics
// this fixture produces are the planted Relates defects:
//   - REL-003 relates to REL-002 (superseded by REL-003) → RELATES_SUPERSEDED
//   - REL-003 relates to REL-999 (never existed)         → BROKEN_RELATES
// Per CLAUDE.md: keep the planted mess — do not "fix" the SPEC.md.

// @spec REL-001
export function reserveInventory(): void {
  // hold stock before capture
}

// @spec REL-003
export function adaptiveExpiry(): void {
  // expiry scales with checkout load
}
