// packages/engine/src/operations/gate.ts
//
// The approval gate: pass iff the requirement is Active and the member's pin
// covers its changed-at version. The gate never trusts a warm index, so the
// operation runs the index into the handle it is given before it decides.

import type { GateOutcome, Storage } from "@spec-engine/shared";
import { classifyGate } from "../gate/classify";
import { runIndex } from "../indexer/pipeline";
import { fail, type OpFailure } from "./_result";

export interface GateInput {
  platformDir: string;
  repo: string;
  reqId: string;
}

export interface GateResult {
  ok: true;
  outcome: GateOutcome;
  buildId: string;
}

/** An unknown repo name is a `usage` refusal; NOT_FOUND is reserved for the requirement. */
// @spec GATE-008
export async function gate(input: GateInput, storage: Storage): Promise<GateResult | OpFailure> {
  const { platformDir, repo, reqId } = input;
  const result = await runIndex({ platformDir, storage });
  const req = storage.getRequirement(reqId);
  const repoRow = storage.getRepo(repo);
  if (repoRow === null) return fail("usage", `unknown repo "${repo}"`);
  const outcome = classifyGate({
    req,
    repo: repoRow,
    requestedRepoName: repo,
    requestedReqId: reqId,
  });
  return { ok: true, outcome, buildId: result.build_id };
}
