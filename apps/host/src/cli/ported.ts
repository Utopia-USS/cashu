// The commands the host runs itself. S39 slices add theirs here and delete their lines from
// delegated.ts in the same change.
import { homedir, tmpdir } from "node:os";
import { currentRuntime, type HostRuntime, shippedSkillsSource } from "../runtime.js";
import type { HostStores } from "../stores.js";
import { vehicleCommands } from "./assets/vehicle.js";
import { printConsole } from "./core/console.js";
import { skillsCommand } from "./core/skills.js";
import { genesisCommand } from "./genesis/command.js";
import type { PortedCommand } from "./tree.js";

export interface PortedDeps {
  readonly home?: string;
  readonly tmpDir?: string;
  readonly now?: () => number;
  readonly runtime?: HostRuntime;
  /** Explicit packaged resource location; source builds derive it from the checkout. */
  readonly skillsSource?: string;
  /** Supplied only when Python is absent: mixed sessions retain Python financial ownership. */
  readonly nativeStores?: Pick<HostStores, "vaults">;
}

export function portedCommands(deps: PortedDeps = {}): PortedCommand[] {
  let runs = 0;
  return [
    ...(deps.nativeStores === undefined
      ? []
      : vehicleCommands({
          stores: deps.nativeStores,
          now: deps.now ?? Date.now,
          render: (text, io) =>
            printConsole(io, text, {
              spans: [{ start: 0, end: 7, style: { color: 32 } }],
            }),
        })),
    skillsCommand(deps.skillsSource ?? shippedSkillsSource(deps.runtime ?? currentRuntime())),
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
