import { D, type Decimal, floatRepr } from "@cashu/domain";
import type { VehicleInput } from "./vehicleInput.js";

/** Python cliutil.fmt: half-even cents, space groups and a comma decimal separator. */
function vehicleMoney(value: Decimal, currency: string): string {
  const text = value.quantize(-2).format(",.2f").replaceAll(",", " ").replace(".", ",");
  return `${text} ${currency}`;
}

export function vehicleOutput(
  input: VehicleInput,
  account: { readonly name: string; readonly currency: string; readonly value: string },
): string {
  const money = (value: number) => vehicleMoney(D(floatRepr(value)), account.currency);
  const floor = input.floor ? `, floor ${money(input.floor)}` : "";
  return `Vehicle '${account.name}': bought ${input.date} for ${money(input.price)}, depreciation ${floatRepr(input.rate)}%/yr${floor} → value today ≈ ${vehicleMoney(D(account.value), account.currency)}`;
}
