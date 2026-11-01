// Explicit-profile vehicle writes. Unknown global/default profile selection stays with Python.
import { assets, D, type IsoDate } from "@cashu/domain";
import { runCommand, setVehicle, vehicleAccount } from "@cashu/store";
import { mcpProfile } from "@cashu/store/core";
import type { HostStores } from "../../stores.js";
import { supportsConsoleUnicode } from "../core/console.js";
import type { CommandIo } from "../tree.js";
import { vehicleDecimal, vehicleInput } from "./vehicleInput.js";
import { vehicleOutput } from "./vehicleOutput.js";

const DELEGATE = { kind: "delegate" } as const;
export interface VehicleDeps {
  readonly stores: Pick<HostStores, "vaults">;
  readonly now: () => number;
  /** The shared Rich-compatible console renderer, including the green Vehicle prefix. */
  readonly render: (text: string, io: CommandIo) => void;
}
function localDate(now: number): IsoDate {
  const date = new Date(now);
  return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export async function runVehicleCommand(
  args: readonly string[],
  io: CommandIo,
  root: { readonly profile?: string },
  deps: VehicleDeps,
): Promise<number | typeof DELEGATE> {
  const input = vehicleInput(args);
  const slug = root.profile || io.env.CASHU_PROFILE;
  if (!input || !slug || !supportsConsoleUnicode(io)) return DELEGATE;
  const matches = [...deps.stores.vaults.values()].filter(
    (vault) => mcpProfile(vault.store.read.bind(vault.store))?.slug === slug,
  );
  if (matches.length !== 1) return DELEGATE;
  const vault = matches[0];
  if (!vault) return DELEGATE;
  return vault.queue.run(() => {
    if (io.signal.aborted) return 130;
    const read = vault.store.read.bind(vault.store);
    const profile = mcpProfile(read);
    if (profile?.slug !== slug) return DELEGATE;
    const existing = vehicleAccount(read, input.name);
    const currency = existing?.currency || input.currency || profile.baseCurrency || "PLN";
    const name = existing?.name ?? (input.name || "manual");
    // Legacy noncanonical currencies and Rich markup need the Python representation boundary.
    if (
      !/^[A-Z]{3}$/.test(currency) ||
      name.includes("[") ||
      /:[^:\s]+:/.test(name) ||
      Array.from(name).some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127)
    )
      return DELEGATE;
    const asOf = localDate(deps.now());
    const proposed = {
      name: input.name,
      purchasePrice: vehicleDecimal(input.price),
      purchaseDate: input.date,
      annualRate: vehicleDecimal(input.rate),
      floor: input.floor === null ? null : vehicleDecimal(input.floor),
      currency,
      asOf,
    };
    // Delegate legacy valuation/format errors before writing. Never retry an append failure.
    let output: string;
    try {
      const value = assets.depreciatedValue(
        D(proposed.purchasePrice),
        proposed.purchaseDate,
        D(proposed.annualRate),
        asOf,
        proposed.floor === null ? null : D(proposed.floor),
      );
      output = vehicleOutput(input, { name, currency, value: value.format("f") });
    } catch {
      return DELEGATE;
    }
    const result = runCommand(vault.store, vault.writer, setVehicle, proposed, vault.env);
    if (!result.ok) throw new Error("native vehicle command refused validated input");
    deps.render(output, io);
    return 0;
  });
}

/** Other assets subcommands retain their existing delegation path. */
export function vehicleCommands(deps: VehicleDeps) {
  return [
    {
      name: "set-vehicle",
      run: (args: readonly string[], io: CommandIo, root: { readonly profile?: string }) =>
        runVehicleCommand(args, io, root, deps),
    },
    {
      name: "assets",
      run: async (args: readonly string[], io: CommandIo, root: { readonly profile?: string }) =>
        args[0] === "set-vehicle" ? runVehicleCommand(args.slice(1), io, root, deps) : DELEGATE,
    },
  ];
}
