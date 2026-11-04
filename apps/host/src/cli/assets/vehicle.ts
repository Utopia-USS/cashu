// Explicit-profile vehicle writes through the native durable command path.
import { assets, D, type IsoDate } from "@cashu/domain";
import { setVehicle, vehicleAccount } from "@cashu/store";
import { mcpProfile } from "@cashu/store/core";
import type { HostStores } from "../../stores.js";
import { cliCommandKey, reportCliCommandFailure, runCliVaultCommand } from "../commandOutcome.js";
import type { CommandIo } from "../tree.js";
import { vehicleDecimal, vehicleInput } from "./vehicleInput.js";
import { vehicleOutput } from "./vehicleOutput.js";

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
): Promise<number> {
  const input = vehicleInput(args);
  const slug = root.profile || io.env.CASHU_PROFILE;
  if (!input) {
    io.stderr(
      "Usage: cashu set-vehicle NAME PRICE DATE [--rate PERCENT] [--floor AMOUNT] [--currency CODE]\n",
    );
    return 2;
  }
  if (!slug) {
    io.stderr("Select a profile with --profile or CASHU_PROFILE.\n");
    return 2;
  }
  const matches = [...deps.stores.vaults.values()].filter(
    (vault) => mcpProfile(vault.store.read.bind(vault.store))?.slug === slug,
  );
  if (matches.length !== 1) {
    io.stderr("Selected profile is not an open native vault.\n");
    return 2;
  }
  const vault = matches[0];
  if (!vault) return 2;
  const key = cliCommandKey();
  if (io.signal.aborted) return 130;
  const read = vault.store.read.bind(vault.store);
  const profile = mcpProfile(read);
  if (profile?.slug !== slug) {
    io.stderr("Selected profile changed.\n");
    return 2;
  }
  const existing = vehicleAccount(read, input.name);
  const currency = existing?.currency || input.currency || profile.baseCurrency || "PLN";
  const name = existing?.name ?? (input.name || "manual");
  // The native renderer prints names literally; only control characters are unsafe in one line.
  if (
    !/^[A-Z]{3}$/.test(currency) ||
    Array.from(name).some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127)
  ) {
    io.stderr("Invalid vehicle name or currency.\n");
    return 2;
  }
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
  // Validate valuation and format before writing. Never retry an append failure.
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
    io.stderr("Invalid vehicle depreciation terms.\n");
    return 2;
  }
  const result = await runCliVaultCommand(
    vault,
    setVehicle,
    proposed,
    key,
    () =>
      !io.signal.aborted &&
      deps.stores.vaults.get(vault.id) === vault &&
      mcpProfile(vault.store.read.bind(vault.store))?.slug === slug,
  );
  if (result.kind !== "completed") return reportCliCommandFailure(io, result, key, setVehicle.id);
  deps.render(output, io);
  return 0;
}

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
        args[0] === "set-vehicle"
          ? runVehicleCommand(args.slice(1), io, root, deps)
          : Promise.resolve(2),
    },
  ];
}
