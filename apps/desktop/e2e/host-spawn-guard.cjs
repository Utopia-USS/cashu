// The main of a private test-only Electron app (`launchGuardedDesktop`). It runs before the real
// desktop entry and replaces every JS child spawn: main never starts a host, so no production host and
// no OS key store is ever reached; the spec serves the data dir with its own synthetic host. When
// E2E_RECOVERY_FAILURE names a failure, a host start "fails" the way a real host does: the typed
// failure record lands in `<data dir>/diagnostics/startup-failure.json` (fresh time) and the host log
// gets lines, some of them hostile synthetic values the report must drop.
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");
const { appendFileSync, mkdirSync, realpathSync, renameSync, writeFileSync } = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");

const main = process.env.E2E_GUARD_MAIN;
const dataDir = process.env.E2E_GUARD_DATA_DIR;
const tempRoot = realpathSync(tmpdir());
if (
  !dataDir ||
  !main ||
  resolve(dataDir) !== dataDir ||
  realpathSync(dataDir) !== dataDir ||
  !dataDir.startsWith(`${tempRoot}/`) ||
  !/^(?:cashu-recovery-e2e-[^/]+\/home\/cashU-data|cashu-e2e-desktop-[^/]+\/native-host\/s56b-[^/]+)$/.test(
    dataDir.slice(tempRoot.length + 1),
  ) ||
  realpathSync(main) !== main
)
  throw new Error("synthetic_spawn_guard_required");

const failure = process.env.E2E_RECOVERY_FAILURE
  ? JSON.parse(process.env.E2E_RECOVERY_FAILURE)
  : null;
const hostile = process.env.E2E_RECOVERY_HOSTILE ?? "";

childProcess.spawn = () => {
  appendFileSync(join(dataDir, "test-spawns"), "host\n", { mode: 0o600 });
  if (failure === null) throw new Error("synthetic_spawn_denied");
  const logs = join(dataDir, "logs");
  mkdirSync(logs, { recursive: true, mode: 0o700 });
  appendFileSync(
    join(logs, "host.log"),
    [
      JSON.stringify({ at: new Date().toISOString(), level: "info", event: "host.started" }),
      JSON.stringify({
        at: new Date().toISOString(),
        level: "error",
        event: "host.start-failure",
        code: failure.code,
        detail: failure.detail,
        error: "StartupFailureError",
        note: hostile,
      }),
      `native_sync_failed Error ${hostile}`,
      `${hostile}\n`,
    ].join("\n"),
    { mode: 0o600 },
  );
  const diagnostics = join(dataDir, "diagnostics");
  mkdirSync(diagnostics, { recursive: true, mode: 0o700 });
  const record = join(diagnostics, "startup-failure.json");
  writeFileSync(
    `${record}.tmp`,
    `${JSON.stringify({ format: 1, failure, at: Date.now(), build: "desktop-dev" })}\n`,
    { mode: 0o600 },
  );
  renameSync(`${record}.tmp`, record);
  const child = new EventEmitter();
  child.unref = () => {};
  return child;
};
syncBuiltinESMExports();
void import(pathToFileURL(main).href);
