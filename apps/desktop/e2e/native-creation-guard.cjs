// This file is the main of a private test-only Electron app. It executes before the real desktop
// entry is imported and denies every JS child spawn. In particular, connectOrStart cannot
// launch the ordinary OS-KeyStore host during handover.
const childProcess = require("node:child_process");
const { appendFileSync, realpathSync } = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");

const main = process.env.E2E_NATIVE_CREATE_MAIN;
const dataDir = process.env.E2E_NATIVE_CREATE_DATA_DIR;
const tempRoot = realpathSync(tmpdir());
if (
  !dataDir ||
  !main ||
  resolve(dataDir) !== dataDir ||
  realpathSync(dataDir) !== dataDir ||
  !dataDir.startsWith(`${tempRoot}/`) ||
  !/^t44-test-[^/]+\/data$/.test(dataDir.slice(tempRoot.length + 1)) ||
  realpathSync(main) !== main
)
  throw new Error("synthetic_creation_guard_required");

const denyFile = join(dataDir, "test-spawn-denied");
childProcess.spawn = () => {
  appendFileSync(denyFile, "blocked\n", { mode: 0o600 });
  throw new Error("synthetic_creation_spawn_denied");
};
syncBuiltinESMExports();
appendFileSync(join(dataDir, "test-guard-ready"), `${process.pid}\n`, { mode: 0o600 });
void import(pathToFileURL(main).href);
