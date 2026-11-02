import type { PortedCommand } from "../tree.js";
import { cashCommands } from "./cash.js";
import { categorizeCommands } from "./categorizeCommands.js";
import type { BudgetCliDeps } from "./context.js";
import { cushionCommand } from "./cushion.js";
import { importCommands } from "./importCommands.js";
import { monthCloseCommand } from "./monthClose.js";

/** The root and `budget` aliases share each native handler. Unknown subcommands delegate. */
export function budgetCommands(deps: BudgetCliDeps): PortedCommand[] {
  const rootLeaves = [...cashCommands(deps), ...importCommands(deps), ...categorizeCommands(deps)];
  const leaves = [...rootLeaves, monthCloseCommand(deps), cushionCommand(deps)];
  return [
    ...rootLeaves,
    {
      name: "budget",
      run(args, io, root) {
        const [name, ...rest] = args;
        const leaf = leaves.find((c) => c.name === name);
        return leaf ? leaf.run(rest, io, root) : Promise.resolve({ kind: "delegate" as const });
      },
    },
  ];
}
