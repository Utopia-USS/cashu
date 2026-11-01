// The real host composition with a fault hook, spawned by the crash tests (Node type stripping):
// after N command commits it SIGKILLs itself before the reply (0 = never). Prints "ready <pid>" once
// serving; exits 3 when another host holds the lock, as the real host does.
// Usage: faultHost.ts <data dir> <home> <kill after commits> <linger ms>
import { HostBusyError } from "@cashu/node-host";
import { startLocalHost } from "../host.js";

const [dataDir, home, killAfter, linger] = process.argv.slice(2);
if (dataDir === undefined || home === undefined) {
  console.error("usage: faultHost.ts <data dir> <home> <kill after commits> <linger ms>");
  process.exit(64);
}
const limit = Number(killAfter ?? "0");
let commits = 0;

try {
  const host = await startLocalHost({
    dataDir,
    home,
    build: "fault",
    lingerMs: Number(linger ?? "60000"),
    afterCommit() {
      commits += 1;
      if (limit > 0 && commits >= limit) process.kill(process.pid, "SIGKILL");
    },
  });
  console.log(`ready ${process.pid}${host.safeMode ? " safe" : ""}`);
  process.exitCode = await host.exit;
} catch (error) {
  if (error instanceof HostBusyError) {
    console.log(`busy ${process.pid}`);
    process.exit(error.exitCode);
  }
  throw error;
}
