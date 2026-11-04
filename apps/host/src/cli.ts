#!/usr/bin/env node
// Entry point of `cashu-host` (dev: node --experimental-strip-types --import
// <repo>/tools/node-ts/resolveTs.ts apps/host/src/cli.ts run --data-dir <dir>). The packaged host is
// one bundled file run by the app's binary in Node mode (S47).
import { createInterface } from "node:readline";
import { main } from "./main.js";

/** stdin lines, opened on the first read only (`migrate --json` waits for one answer). */
let lines: AsyncIterator<string> | undefined;
async function readLine(): Promise<string | null> {
  lines ??= createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY })[
    Symbol.asyncIterator
  ]();
  const next = await lines.next();
  return next.done ? null : next.value;
}

const code = await main(process.argv.slice(2), {
  env: process.env,
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
  onSignal(handler) {
    process.once("SIGTERM", handler);
    process.once("SIGINT", handler);
  },
  build: process.env.CASHU_BUILD ?? "dev",
  readLine,
});
process.exit(code);
