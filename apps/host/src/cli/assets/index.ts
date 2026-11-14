import { N } from "../native.strings.js";
import type { PortedCommand } from "../tree.js";
import { positionCommands, runAddPosition } from "./position.js";
import { runVehicleCommand, type VehicleDeps } from "./vehicle.js";

/** Assets group and top-level aliases share the same native leaves. */
export function assetCommands(deps: VehicleDeps): PortedCommand[] {
  return [
    ...positionCommands(deps),
    {
      name: "set-vehicle",
      run: (args, io, root) => runVehicleCommand(args, io, root, deps),
    },
    {
      name: "assets",
      run: (args, io, root) => {
        if (args[0] === "add-position") return runAddPosition(args.slice(1), io, root, deps);
        if (args[0] === "set-vehicle") return runVehicleCommand(args.slice(1), io, root, deps);
        io.stderr(`${io.t.tr(N.assetsUsage)}\n`);
        return Promise.resolve(2);
      },
    },
  ];
}
