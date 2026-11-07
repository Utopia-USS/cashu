// The main of a private test-only Electron app (`launchGuardedDesktop`). It runs before the real
// desktop entry and replaces every JS child spawn: main never starts a host or a migration, so no
// production host and no OS key store is ever reached; the spec serves the data dir with its own
// synthetic host. When E2E_RECOVERY_FAILURE names a failure, a host start "fails" the way a real host does:
// the typed failure record lands in `<data dir>/diagnostics/startup-failure.json` (fresh time) and
// the host log gets lines, some of them hostile synthetic values the report must drop. When
// E2E_RECOVERY_MIGRATE is "1", "Import my data" runs for real: the dev migrate child (Electron as Node
// on apps/host/src/cli.ts) is started with apps/host/src/testing/syntheticMigrate.ts instead (same
// binary, arguments and environment; an in-memory test key store, never the OS keychain).
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");
const { appendFileSync, mkdirSync, realpathSync, renameSync, writeFileSync } = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const { tmpdir } = require("node:os");
const { dirname, join, resolve } = require("node:path");
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
  !(
    /^(?:cashu-recovery-e2e-[^/]+\/home\/cashU-data|cashu-e2e-desktop-[^/]+\/native-host\/s56b-[^/]+)$/.test(
      dataDir.slice(tempRoot.length + 1),
    ) ||
    // The real-import spec: the only layout the synthetic test key store accepts.
    (process.env.E2E_RECOVERY_MIGRATE === "1" &&
      /^t44-test-[^/]+\/data$/.test(dataDir.slice(tempRoot.length + 1)))
  ) ||
  realpathSync(main) !== main
)
  throw new Error("synthetic_spawn_guard_required");

const originalSpawn = childProcess.spawn;
const migrateForReal = process.env.E2E_RECOVERY_MIGRATE === "1";
const repo = process.env.E2E_REPO;
const HOST_CLI = repo ? join(repo, "apps", "host", "src", "cli.ts") : null;
const SYNTHETIC_MIGRATE = repo
  ? join(repo, "apps", "host", "src", "testing", "syntheticMigrate.ts")
  : null;

/** The dev migrate child's arguments with the synthetic entry, or null when they are not exactly it. */
function syntheticMigrateArgs(args) {
  if (!migrateForReal || HOST_CLI === null || !Array.isArray(args)) return null;
  const at = args.indexOf(HOST_CLI);
  const tail = args.slice(at + 1);
  if (
    at < 0 ||
    tail.length !== 4 ||
    tail[0] !== "migrate" ||
    tail[1] !== "--data-dir" ||
    tail[2] !== dataDir ||
    tail[3] !== "--json"
  )
    return null;
  return [...args.slice(0, at), SYNTHETIC_MIGRATE, ...tail];
}

const failure = process.env.E2E_RECOVERY_FAILURE
  ? JSON.parse(process.env.E2E_RECOVERY_FAILURE)
  : null;
const hostile = process.env.E2E_RECOVERY_HOSTILE ?? "";

childProcess.spawn = (command, args, options) => {
  const kind = Array.isArray(args) && args.includes("migrate") ? "migrate" : "host";
  if (kind === "migrate") {
    const synthetic = syntheticMigrateArgs(args);
    if (synthetic === null || options?.env?.CASHU_TESTING !== "1")
      throw new Error("synthetic_spawn_denied");
    // Recorded beside the data dir: the import refuses any entry in it it does not know.
    appendFileSync(join(dirname(dataDir), "test-migrate-spawns"), "migrate\n", { mode: 0o600 });
    return originalSpawn(command, synthetic, options);
  }
  appendFileSync(join(dataDir, "test-spawns"), `${kind}\n`, { mode: 0o600 });
  if (kind !== "host" || failure === null) throw new Error("synthetic_spawn_denied");
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
