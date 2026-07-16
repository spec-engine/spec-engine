// packages/shared/src/config.ts
//
// Zod schema for the member-facing config file. Phase 2's `spec index`
// calls this to validate spec-engine.member.json (per-repo pin).
// RED-85: the spec-engine.platform.json manifest schema is retired — the
// platform version is DERIVED (max domain version), never authored.
//
// V5 Input Validation: this is the runtime-validation seam.

import { z } from "zod";

export const SpecConfigSchema = z.object({
  specs: z
    .string()
    .regex(/^spec-engine@\d+$/, "must be of the form spec-engine@N where N is an integer"),
  // Audit hygiene pass T7: optional repo-relative directory prefixes to
  // exclude from this repo's tag/doc scans, layered ON TOP of the hardcoded
  // scanner ignore list (additive only — entries can never re-include a
  // hardcoded ignore like `fixtures/`). Matched with the scanner's
  // substring-with-trailing-slash contract; a bare name normalizes to
  // `name/` at scan time.
  ignore: z.array(z.string().min(1, "ignore entries must be non-empty strings")).optional(),
  // 2.7 monorepo expansion: an OPTIONAL glob (relative to this config's own
  // directory) that expands this member into workspace sub-members — one per
  // matching subdirectory — instead of registering the config's directory as a
  // single member. e.g. a monorepo whose packages live under `packages/*` sets
  // `"members": "*"` in `packages/spec-engine.member.json` so engine/shared/…
  // each get their OWN coverage column and can carry their OWN pin (a nested
  // spec-engine.member.json), rather than collapsing into one attribution blob.
  members: z.string().min(1, "members must be a non-empty glob").optional(),
});

export type SpecConfig = z.infer<typeof SpecConfigSchema>;
