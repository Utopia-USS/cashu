// TRANSITIONAL(S49): `cashu bridge init|run --once|status`, the outbox bridge's commands in the host
// (S56c; they replace `cashu-sync-daemon init|run|status --config`). The service runs the loop by
// itself; these are the operator's and the lab harness's handles on it:
//   init        the first start of a quiescent Python data dir: every profile becomes a vault.
//   run --once  iterations until the outbox is idle, now (also gets past a fixed block).
//   status      the service state and per-vault counts.
// Output: one JSON line per step (counts and short codes only), English (operator output). Exit codes
// as the daemon's: 0 ok, 64 usage / refusal, 65 blocked (D4), 70 failure.
import type { CommandIo, PortedCommand } from "../cli/tree.js";
import type { Line, RunOutcome, SyncService } from "./service.js";

const USAGE = "usage: cashu bridge init|run --once|status";

function exitOf(outcome: RunOutcome, io: CommandIo): number {
  switch (outcome.kind) {
    case "idle":
      return 0;
    case "blocked":
      io.stdout(`${JSON.stringify({ blocked: outcome.reason })}\n`);
      return 65;
    case "refused":
      io.stderr(`cashu bridge: refused (${outcome.reason})\n`);
      return 64;
    case "failed":
      io.stderr(`cashu bridge: failed (${outcome.error})\n`);
      return 70;
  }
}

/** The `bridge` command over the host's sync service (it may still be starting: awaited). */
export function bridgeCommand(service: () => Promise<SyncService | undefined>): PortedCommand {
  return {
    name: "bridge",
    async run(args, io) {
      const sync = await service();
      const out = (line: Line) => io.stdout(`${JSON.stringify(line)}\n`);
      const [command, ...rest] = args;
      if (sync === undefined) {
        io.stderr("cashu bridge: the sync service is not running\n");
        return 64;
      }
      if (command === "status" && rest.length === 0) {
        out({ step: "status", ...sync.status() });
        return 0;
      }
      if (command === "init" && rest.length === 0) return exitOf(await sync.init(out), io);
      if (command === "run" && rest.length === 1 && rest[0] === "--once") {
        return exitOf(await sync.runOnce(out), io);
      }
      io.stderr(`${USAGE}\n`);
      return 64;
    },
  };
}
