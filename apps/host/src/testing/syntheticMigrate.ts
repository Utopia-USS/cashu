// Source-only `migrate --data-dir <D> --json` child for the desktop e2e (104-recovery-screen): the
// spawn guard (apps/desktop/e2e/host-spawn-guard.cjs) runs it in place of apps/host/src/cli.ts when a
// spec opts in. The same `migrateCommand` as production, with an in-memory key store in a fresh
// `cashu-next-test.<hex>` namespace (never the OS keychain) and no launchctl runner: with the
// harness's temp CASHU_LAUNCH_AGENTS_DIR only its synthetic plists are removed. Production main.ts
// never imports this, and it refuses any invocation outside the e2e's temp layout (`<tmp>/t44-test-*/data`,
// the only one the test key store accepts, with HOME and LaunchAgents beside it).
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { migrateCommand } from "../migration/cli.js";
import { memoryKeychain } from "../migration/testing/inPlaceFixture.js";

const argv = process.argv.slice(2);
const dataDir = argv[2];
const temp = realpathSync(tmpdir());
const root = dataDir === undefined ? "" : dirname(dataDir);
const valid =
  process.env.CASHU_TESTING === "1" &&
  argv.length === 4 &&
  argv[0] === "migrate" &&
  argv[1] === "--data-dir" &&
  argv[3] === "--json" &&
  dataDir !== undefined &&
  resolve(dataDir) === dataDir &&
  realpathSync(dataDir) === dataDir &&
  dataDir === process.env.CASHU_DATA_DIR &&
  dataDir.startsWith(`${temp}/`) &&
  /^t44-test-[^/]+\/data$/.test(dataDir.slice(temp.length + 1)) &&
  process.env.HOME === join(root, "home") &&
  process.env.CASHU_LAUNCH_AGENTS_DIR === join(root, "LaunchAgents");
if (!valid) {
  console.error("synthetic migrate: invalid test invocation");
  process.exit(64);
}

let lines: AsyncIterator<string> | undefined;
async function readLine(): Promise<string | null> {
  lines ??= createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY })[
    Symbol.asyncIterator
  ]();
  const next = await lines.next();
  return next.done ? null : next.value;
}

const code = await migrateCommand(argv.slice(1), {
  env: process.env,
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
  readLine,
  build: process.env.CASHU_BUILD ?? "desktop-dev",
  keychain: memoryKeychain(dataDir as string).keychain,
});
process.exit(code);
