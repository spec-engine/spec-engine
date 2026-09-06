// packages/engine/src/testing/dependencyPlatform.ts

import type { TestPlatform } from "./platform";

/** The member names of `dependencyPlatform`, by name and by dependency depth. */
export const DEPENDENCY_MEMBERS = {
  byName: ["api", "shared", "web", "zed"],
  byDepth: ["shared", "zed", "api", "web"],
} as const;

/**
 * A platform whose dependency order differs from its name order: `web`
 * depends on `api`, `api` on `shared`, and `zed` on nothing. One BILLING
 * chain of two: `shared` verifies the head, `api` still implements the
 * predecessor, `web` implements the head, `zed` references nothing.
 */
export async function dependencyPlatform(
  fx: TestPlatform,
): Promise<{ predecessor: string; head: string }> {
  const [predecessor, head] = (await (await fx.domain("BILLING")).chain(2)) as [string, string];
  await fx.member("shared", { files: { "src/a.test.ts": `// @spec ${head} unit\n` } });
  await fx.member("api", {
    dependsOn: ["shared"],
    files: { "src/a.ts": `// @spec ${predecessor}\n` },
  });
  await fx.member("web", { dependsOn: ["api"], files: { "src/a.ts": `// @spec ${head}\n` } });
  await fx.member("zed", { files: { "src/a.ts": "export {};\n" } });
  return { predecessor, head };
}
