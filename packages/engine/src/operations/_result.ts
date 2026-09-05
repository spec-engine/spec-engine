// packages/engine/src/operations/_result.ts
//
// The result contract every operation returns. An operation never exits the
// process and never writes to a console: it succeeds with data plus any
// warnings, or fails with a typed reason each surface maps to its own
// vocabulary (CLI exit code, HTTP status, MCP isError).

import type { Diagnostic } from "@spec-engine/shared";

/** Why an operation refused. The surface decides what that means to a caller. */
export type OpReason =
  | "usage"
  | "not_found"
  | "conflict"
  | "invalid_domain_file"
  | "not_a_platform";

/** A notice worth a stderr line. `kind` lets a surface keep its own wording per class. */
export interface OpWarning {
  kind: "grammar" | "ref" | "index";
  text: string;
}

export interface OpFailure {
  ok: false;
  reason: OpReason;
  /** Human-readable, surface-neutral: no `spec <cmd>:` prefix, no exit code. */
  detail: string;
  /** Structural diagnostics from the shared validator, when `reason` is `invalid_domain_file`. */
  diagnostics?: Diagnostic[];
  /** Warnings raised before the refusal, so a surface can still show them. */
  warnings?: OpWarning[];
}

export function fail(
  reason: OpReason,
  detail: string,
  extra: { diagnostics?: Diagnostic[]; warnings?: OpWarning[] } = {},
): OpFailure {
  const out: OpFailure = { ok: false, reason, detail };
  if (extra.diagnostics) out.diagnostics = extra.diagnostics;
  if (extra.warnings && extra.warnings.length > 0) out.warnings = extra.warnings;
  return out;
}

/** CLI exit code for a failure. Every refusal is a usage-class exit 2; a
 *  data-level exit 1 is a successful operation whose data says "red". */
export const EXIT_FOR_REASON: Record<OpReason, 2> = {
  usage: 2,
  not_found: 2,
  conflict: 2,
  invalid_domain_file: 2,
  not_a_platform: 2,
};

/** HTTP status for a failure. */
export const STATUS_FOR_REASON: Record<OpReason, 400 | 404 | 409> = {
  usage: 400,
  not_found: 404,
  conflict: 409,
  invalid_domain_file: 400,
  not_a_platform: 404,
};
