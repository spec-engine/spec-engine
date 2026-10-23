import { validateAndWrite } from "@spec-engine/shared";
import { localToday } from "../authoring/edit";
import type { ReqTagRow } from "../resolve/format";
import { locateEntry } from "./_envelope";
import type { FreshTags } from "./_index";
import { fail, type OpFailure } from "./_result";
import { applyRetag } from "./_retag";

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
  /** The tag sites removed from the code. */
  removed: ReqTagRow[];
}

/**
 * Only an Active or Draft entry deprecates: a superseded entry is already
 * history, a deprecated one is done.
 * @spec REQ-070
 * @spec REQ-075
 * @spec SCHM-043
 */
export async function deprecate(
  input: DeprecateInput,
  freshTags: FreshTags,
): Promise<DeprecateResult | OpFailure> {
  const { platformDir, id, reason } = input;
  const located = await locateEntry(platformDir, id);
  if (!located.ok) return located;
  const { specPath, relFile, domain, req } = located;

  const statusLc = req.status.toLowerCase();
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
  const removed = await applyRetag(platformDir, id, null, freshTags);
  return { ok: true, id, file: relFile, reason, removed };
}
