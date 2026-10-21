import { expect, test } from "bun:test";
import {
  checkExactPins,
  checkPublishOnRelease,
  checkReleasePr,
  checkVersionParity,
  loadReleaseFiles,
  type ReleaseFiles,
} from "./release-config";

function repo(): ReleaseFiles {
  return loadReleaseFiles();
}

// @spec DIST-015 unit
test("DIST-015: a release-please job that also runs on pull requests is refused", () => {
  const f = repo();
  expect(checkReleasePr(f)).toEqual([]);
  const job = f.workflow.jobs["release-please"];
  if (job) job.if = "always()";
  expect(checkReleasePr(f)).toContain("release-please must run on push to main only");
});

// @spec DIST-016 unit
test("DIST-016: a publish job that does not wait for a gate is refused", () => {
  const f = repo();
  expect(checkPublishOnRelease(f)).toEqual([]);
  const job = f.workflow.jobs.publish;
  if (job) job.needs = job.needs?.filter((n) => n !== "site");
  expect(checkPublishOnRelease(f)).toContain("publish must need gate job site");
});

// @spec DIST-017 unit
test("DIST-017: a version parity step after packing is refused", () => {
  const f = repo();
  expect(checkVersionParity(f)).toEqual([]);
  const job = f.workflow.jobs.publish;
  if (job?.steps) job.steps = [...job.steps].reverse();
  expect(checkVersionParity(f)).toEqual(["the version parity step must run before packing"]);
});

// @spec DIST-018 unit
test("DIST-018: a caret range is refused as a non-exact pin", () => {
  const f = repo();
  expect(checkExactPins(f)).toEqual([]);
  f.manifests["package.json"] = { devDependencies: { typescript: "^5.9.3" } };
  expect(checkExactPins(f)).toEqual(["package.json: typescript@^5.9.3 is not an exact pin"]);
});
