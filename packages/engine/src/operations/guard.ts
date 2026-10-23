// The storage handle must hold a fresh index of the working tree; the surface
// checks that the ref resolves before it builds one.

import type { Storage } from "@spec-engine/shared";
import { collectFacts } from "../guard/collect";
import { classifyLosses, type Loss } from "../guard/losses";

export interface GuardResult {
  ok: true;
  ref: string;
  /** Unsorted; the renderer owns the order. Empty means nothing is about to be lost. */
  losses: Loss[];
}

/** @spec GUARD-032 */
export async function guard(
  storage: Storage,
  platformDir: string,
  ref: string,
): Promise<GuardResult> {
  const losses = classifyLosses(await collectFacts(platformDir, ref, storage));
  return { ok: true, ref, losses };
}
