import { expect, test } from "bun:test";
import {
  checkPublishOnRelease,
  checkVersionParity,
  loadReleaseFiles,
  type ReleaseFiles,
} from "./release-config";

function repo(): ReleaseFiles {
  return loadReleaseFiles();
}

// @spec DIST-024 unit
test("a publish job that does not wait for a gate is refused", () => {
  const f = repo();
  expect(checkPublishOnRelease(f)).toEqual([]);
  const job = f.workflow.jobs.publish;
  if (job) job.needs = job.needs?.filter((n) => n !== "site");
  expect(checkPublishOnRelease(f)).toContain("publish must need gate job site");
});

// @spec DIST-024 unit
test("a version parity step after packing is refused", () => {
  const f = repo();
  expect(checkVersionParity(f)).toEqual([]);
  const job = f.workflow.jobs.publish;
  if (job?.steps) job.steps = [...job.steps].reverse();
  expect(checkVersionParity(f)).toEqual(["the version parity step must run before packing"]);
});
