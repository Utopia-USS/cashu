#!/usr/bin/env node
// `cashu`: the thin client of the data dir's local host (S56d). Dev: `pnpm cashu-next <args>` from the
// repo root, or node --experimental-transform-types --import <repo>/tools/node-ts/resolveTs.ts
// apps/cli/src/index.ts <args>; installs reach it through the stable launcher the host writes
// (`<data dir>/bin/cashu`, on Windows `<data dir>\bin\cashu.cmd`). The packaged shim is one bundled
// file run by the app's binary in Node mode (S47).
import { realpathSync } from "node:fs";
import { shimBuild } from "./host.js";
import { main, processShim } from "./main.js";
import { signalEnding } from "./signals.js";

const entry = process.argv[1];
if (entry !== undefined && realpathSync(entry) === realpathSync(import.meta.filename)) {
  const proc = processShim(shimBuild(import.meta.filename, process.env));
  const outcome = await main(process.argv.slice(2), proc);
  const ending = "signal" in outcome ? signalEnding(outcome.signal, process.platform) : outcome;
  if ("signal" in ending) {
    // The foreground host/app process died of a signal: preserve the caller's signal exit.
    process.removeAllListeners(ending.signal);
    process.kill(process.pid, ending.signal);
  } else {
    proc.exit(ending.code);
  }
}
