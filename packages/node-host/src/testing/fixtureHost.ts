// A minimal host process for the node-host tests (run with Node type stripping): takes the data dir's
// lock and socket through `startHost` and answers `admin.status` / `admin.stop`. Exits 3 when another
// host holds the lock, as the real host does. Usage: fixtureHost.ts <data dir> [tmp dir]
import type { AdminStatus } from "@cashu/host-protocol";
import { HostBusyError, type RunningHost, startHost } from "../host/server.js";

const [dataDir, tmpDir] = process.argv.slice(2);
if (dataDir === undefined) {
  console.error("usage: fixtureHost.ts <data dir> [tmp dir]");
  process.exit(64);
}

let host: RunningHost;
try {
  host = await startHost({
    dataDir,
    build: "fixture",
    ...(tmpDir === undefined ? {} : { pathEnv: { tmpDir } }),
    onSession(session) {
      session.onFrame((frame) => {
        if (frame.t !== "req") return;
        if (frame.method === "admin.status") {
          const status: AdminStatus = {
            pid: process.pid,
            build: "fixture",
            protocol: { major: 1, minor: 0 },
            startedAt: host.startedAt.toISOString(),
            dataDir: host.paths.dataDirId,
            sessions: host.sessionCounts(),
            stopping: host.stopping,
          };
          session.send({ t: "res", id: frame.id, outcome: { ok: true, result: status } });
        } else if (frame.method === "admin.stop") {
          session.send({
            t: "res",
            id: frame.id,
            outcome: { ok: true, result: { stopping: true } },
          });
          void host.close().then(() => process.exit(0));
        } else {
          session.send({
            t: "res",
            id: frame.id,
            outcome: { ok: false, error: { code: "unknown-method", message: frame.method } },
          });
        }
      });
    },
  });
} catch (error) {
  if (error instanceof HostBusyError) {
    console.log(`busy ${process.pid}`);
    process.exit(error.exitCode);
  }
  throw error;
}
console.log(`ready ${process.pid}`);
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => void host.close().then(() => process.exit(0)));
}
