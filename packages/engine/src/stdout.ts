import { format } from "node:util";

let lastWrite: Promise<void> = Promise.resolve();

/** A closed read end (`spec list … | head -1`) is the consumer's choice, not a crash. */
function isEpipe(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    (e.code === "EPIPE" || e.code === "ERR_STREAM_DESTROYED")
  );
}

/**
 * Bun queues `console.log` to a pipe once anything has read `process.stdout`
 * and drops the queue when the process ends, so every stdout line is written
 * through the stream and `exit` waits for the last one.
 */
export function routeStdout(): void {
  process.stdout.on("error", (e) => {
    if (!isEpipe(e)) throw e;
  });
  console.log = (...args: unknown[]) => {
    const text = `${format(...args)}\n`;
    lastWrite = new Promise((written) => process.stdout.write(text, () => written()));
  };
}

/** The only exit after stdout output: a `process.exit` before the last write lands truncates it. */
export async function exit(code: number): Promise<never> {
  await lastWrite;
  process.exit(code);
}
