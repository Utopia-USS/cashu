import type { PortedCommand } from "../tree.js";
import type { InvestmentCliDeps } from "./context.js";
import { alertKinds, DELEGATE, localSearch } from "./inspection.js";
import { performance, positions } from "./reports.js";
import { validateFile } from "./validate.js";

export type { InvestmentCliDeps } from "./context.js";

/** Only the selected S39d leaves are native. All other invest commands stay delegated. */
export function investmentCommands(deps: InvestmentCliDeps): PortedCommand[] {
  return [
    {
      name: "invest",
      run(args, io, root) {
        const [name, ...rest] = args;
        if (name === "validate") return validateFile(rest, io);
        if (name === "positions") return Promise.resolve(positions(rest, io, root, deps));
        if (name === "performance") return Promise.resolve(performance(rest, io, root, deps));
        if (name === "search") return Promise.resolve(localSearch(rest, io, root, deps));
        if (name === "alerts" && rest[0] === "kinds")
          return Promise.resolve(alertKinds(rest.slice(1), io));
        return Promise.resolve(DELEGATE);
      },
    },
  ];
}
