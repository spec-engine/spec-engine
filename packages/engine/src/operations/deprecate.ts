// packages/engine/src/operations/deprecate.ts
//
// End a requirement with no successor: mark it deprecated, record the reason
// on the entry itself, and answer with every code tag still bound to the id
// (each is a DEPRECATED_REFERENCED error in `spec check` until the code is
// removed or retagged). A requirement is never deleted; the entry survives as
// the record.

import { validateAndWrite } from "@spec-engine/shared";
import { localToday } from "../authoring/edit";
import type { ReqTagRow } from "../resolve/format";
import { locateEntry } from "./_envelope";
import type { FreshTags } from "./_index";
import { fail, type OpFailure } from "./_result";
import { toReqTagRows } from "./reads";

export interface DeprecateInput {
  platformDir: string;
  id: string;
  /** Why the requirement ended. The durable record; a surface rejects an empty one. */
  reason: string;
}

export interface DeprecateResult {
  ok: true;
  id: string;
  file: string;
  reason: string;
  /** Tag sites still bound to the id after the write. */
  sites: ReqTagRow[];
}

/**
 * Only an Active or Draft entry deprecates: a superseded entry is already
 * history, a deprecated one is done.
 * @spec REQ-021
 * @spec REQ-038
 * @spec SCHM-024
 */
export async function deprecate(
  input: DeprecateInput,
  freshTags: FreshTags,
): Promise<DeprecateResult | OpFailure> {
  const { platformDir, id, reason } = input;
  const located = await locateEntry(platformDir, id);
  if (!located.ok) return located;
  const { specPath, relFile, domain, req } = located;

  const statusLc = (typeof req.status === "string" ? req.status : "").toLowerCase();
  if (statusLc === "deprecated" || statusLc === "retired") {
    return fail("conflict", `${id} is already deprecated`);
  }
  if (statusLc !== "active" && statusLc !== "draft") {
    return fail(
      "conflict",
      `${id} is ${req.status} — only Active/Draft entries deprecate (a superseded entry is already history)`,
    );
  }

  req.status = "deprecated";
  req.deprecatedReason = reason;
  domain.updated = localToday();
  const res = await validateAndWrite(specPath, domain, relFile);
  if (!res.ok) {
    return fail("invalid_domain_file", res.diagnostics.map((d) => d.detail).join("\n"), {
      diagnostics: res.diagnostics,
    });
  }
  const sites = toReqTagRows(await freshTags(id));
  return { ok: true, id, file: relFile, reason, sites };
}
