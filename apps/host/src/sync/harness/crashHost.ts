// Milestone-only fault injection into the real host. The loop logs the point before this hook,
// so the parent verifies both SIGKILL and the durable boundary without a racy external log watcher.
import { startLocalHost } from "../../host.js";

const [dataDir, home, target] = process.argv.slice(2);
if (
  dataDir === undefined ||
  home === undefined ||
  !["intent", "written", "acked"].includes(target ?? "")
) {
  process.exit(64);
}
const host = await startLocalHost({
  dataDir,
  home,
  build: "dev",
  lingerMs: 60_000,
  syncAt(point) {
    if (point === target) process.kill(process.pid, "SIGKILL");
  },
});
process.exitCode = await host.exit;
