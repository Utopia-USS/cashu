// The commands the host runs itself. S39 slices add theirs here and delete their lines from
// delegated.ts in the same change.
import { homedir, tmpdir } from "node:os";
import { genesisCommand } from "./genesis/command.js";
import type { PortedCommand } from "./tree.js";

export interface PortedDeps {
  readonly home?: string;
  readonly tmpDir?: string;
  readonly now?: () => number;
}

export function portedCommands(deps: PortedDeps = {}): PortedCommand[] {
  let runs = 0;
  return [
    {
      // Lab / dev: the genesis event log of a Python data dir (S26). Synchronous work: it holds the
      // host's event loop for its duration (a worker thread is the S39 runner's call).
      name: "genesis",
      async run(args, io) {
        runs += 1;
        return genesisCommand(args, {
          home: deps.home ?? homedir(),
          tmpDir: deps.tmpDir ?? tmpdir(),
          runId: `${process.pid}-${runs}`,
          now: deps.now ?? Date.now,
          stdout: (line) => io.stdout(`${line}\n`),
          stderr: (line) => io.stderr(`${line}\n`),
        });
      },
    },
  ];
}
