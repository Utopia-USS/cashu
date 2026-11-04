import type { PortedCommand } from "../tree.js";
import { accounts } from "./accounts.js";
import type { InvestmentCliDeps } from "./context.js";
import { importFile } from "./import.js";
import { alertKinds, DELEGATE, localSearch } from "./inspection.js";
import { macroRefresh } from "./macro.js";
import { instrumentsMerge } from "./merge.js";
import { performance, positions } from "./reports.js";
import { runInvestment } from "./run.js";
import { signals } from "./signals.js";
import { strategy } from "./strategy.js";
import { validateFile } from "./validate.js";

export type { InvestmentCliDeps } from "./context.js";

/** Native leaves use the selected vault and existing store services. */
export function investmentCommands(deps: InvestmentCliDeps): PortedCommand[] {
  return [
    {
      name: "invest",
      run(args, io, root) {
        const [name, ...rest] = args;
        if (name === "validate") return validateFile(rest, io);
        if (name === "positions") return Promise.resolve(positions(rest, io, root, deps));
        if (name === "performance") return Promise.resolve(performance(rest, io, root, deps));
        if (name === "accounts") return accounts(rest, io, root, deps);
        if (name === "signals") return Promise.resolve(signals(rest, io, root, deps));
        if (name === "strategy") return strategy(rest, io, root, deps);
        if (name === "import") return importFile(rest, io, root, deps);
        if (name === "run") return runInvestment(rest, io, root, deps);
        if (name === "macro") return macroRefresh(rest, io, root, deps);
        if (name === "instruments") return instrumentsMerge(rest, io, root, deps);
        if (name === "search") return Promise.resolve(localSearch(rest, io, root, deps));
        if (name === "alerts" && rest[0] === "kinds")
          return Promise.resolve(alertKinds(rest.slice(1), io));
        return Promise.resolve(DELEGATE);
      },
    },
  ];
}
