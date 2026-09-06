// packages/webapp/src/pages/propagation.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Storage } from "@spec-engine/shared";
import { runIndex } from "@spec-engine/spec-engine/src/indexer/pipeline";
import { mountApi } from "@spec-engine/spec-engine/src/server/api";
import { openStorage } from "@spec-engine/spec-engine/src/storage/sqlite";
import {
  DEPENDENCY_MEMBERS,
  dependencyPlatform,
} from "@spec-engine/spec-engine/src/testing/dependencyPlatform";
import { TestPlatform } from "@spec-engine/spec-engine/src/testing/platform";
import { Hono } from "hono";
import { mountWebapp } from "../server";

let fx: TestPlatform;
let storage: Storage;
let app: Hono;
let head: string;

beforeAll(async () => {
  fx = TestPlatform.temp("spec-webapp-propagation-");
  head = (await dependencyPlatform(fx)).head;
  storage = openStorage(join(fx.dir, ".spec-engine", "index.sqlite"));
  await runIndex({ platformDir: fx.dir, storage });
  app = new Hono();
  mountApi(app, storage, fx.dir);
  mountWebapp(app);
});

afterAll(() => {
  storage.close();
  fx.remove();
});

describe("GET /propagation/:id", () => {
  // @spec PROP-006 integration
  test("lists members in the API's order: dependency depth, then name", async () => {
    const res = await app.request(`/propagation/${head}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    const members = [...html.matchAll(/<tr>\s*<td>([^<]+)<\/td>/g)].map((m) => m[1]);
    expect(members).toEqual([...DEPENDENCY_MEMBERS.byDepth]);
  });
});
