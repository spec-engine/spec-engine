import { expect, test } from "bun:test";
import { join } from "node:path";
import { TestPlatform } from "./testing/platform";
import { SPEC_TOKEN } from "./testing/specTag";

const CLI = join(import.meta.dir, "cli.ts");

test("a check report larger than one pipe buffer reaches a slow reader whole", async () => {
  const fx = TestPlatform.temp();
  try {
    await fx.domain("BIG");
    const dangling = Array.from({ length: 3000 }, (_, i) => `// ${SPEC_TOKEN} BIG-${i + 100}`);
    fx.file("src/a.ts", `${dangling.join("\n")}\n`);
    const cmd = [process.execPath, CLI, "check", fx.dir, "--json"];

    const slow = Bun.spawn({ cmd, stdout: "pipe", stderr: "ignore" });
    await Bun.sleep(500);
    const piped = await new Response(slow.stdout).text();
    expect(await slow.exited).toBe(1);

    const drained = new TextDecoder().decode(
      Bun.spawnSync({ cmd, stdout: "pipe", stderr: "ignore" }).stdout,
    );
    expect(piped.length).toBeGreaterThan(65536);
    expect(piped).toBe(drained);
    expect(JSON.parse(piped)).toHaveLength(3000);
  } finally {
    fx.remove();
  }
});
