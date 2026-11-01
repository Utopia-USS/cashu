#!/usr/bin/env node
// `cashu`: the thin client of the data dir's local host (S56d). Dev: `pnpm cashu-next <args>` from the
// repo root, or node --experimental-strip-types --import <repo>/tools/node-ts/resolveTs.ts
// apps/cli/src/index.ts <args>; installs reach it through the stable launcher `<data dir>/bin/cashu`
// that the host writes. The packaged shim is one bundled file run by the app's binary in Node mode (S47).
import { realpathSync } from "node:fs";
import { shimBuild } from "./host.js";
import { main, processShim } from "./main.js";

const entry = process.argv[1];
if (entry !== undefined && realpathSync(entry) === realpathSync(import.meta.filename)) {
  const proc = processShim(shimBuild(import.meta.filename, process.env));
  const outcome = await main(process.argv.slice(2), proc);
  if ("signal" in outcome) {
    // The delegated command died of a signal: die of the same one (default action restored).
    process.removeAllListeners(outcome.signal);
    process.kill(process.pid, outcome.signal);
  } else {
    proc.exit(outcome.code);
  }
}
