// packages/engine/src/parser/grammar.ts
//
// Format-agnostic requirement-ID grammar. `ID_RE` (KEY-NNN) is CANONICALLY
// defined in @spec-engine/shared (P3 consolidation — one source, not three);
// this module re-exports it so the existing engine importers (commands/amend,
// commands/supersede, server/mcp) keep their `../parser/grammar` import path.

export { ID_RE } from "@spec-engine/shared";
