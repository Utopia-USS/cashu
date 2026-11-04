// A private test-only Electron bootstrap for the plaintext synthetic Overview fixture.
// Its renderer can reconnect only to the explicitly supervised synthetic host.
const childProcess = require("node:child_process");
const { appendFileSync, realpathSync } = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");

const root = process.env.E2E_ROOT;
const dataDir = process.env.E2E_NATIVE_DATA_DIR;
const main = process.env.E2E_NATIVE_OVERVIEW_MAIN;
const tempRoot = realpathSync(tmpdir());
if (
  !root ||
  !dataDir ||
  !main ||
  resolve(root) !== root ||
  realpathSync(root) !== root ||
  !root.startsWith(`${tempRoot}/`) ||
  !/^cashu-e2e-desktop-[^/]+$/.test(root.slice(tempRoot.length + 1)) ||
  dataDir !== join(root, "native-data") ||
  realpathSync(dataDir) !== dataDir ||
  realpathSync(main) !== main
)
  throw new Error("synthetic_overview_guard_required");

childProcess.spawn = () => {
  appendFileSync(join(root, "overview-spawn-denied"), "blocked\n", { mode: 0o600 });
  throw new Error("synthetic_overview_spawn_denied");
};
syncBuiltinESMExports();
appendFileSync(join(root, "overview-guard-ready"), `${process.pid}\n`, { mode: 0o600 });
void import(pathToFileURL(main).href);
