// One atomic vehicle write, including the valuation Python computes before its session commits.
import { assets, D } from "@cashu/domain";
import { z } from "zod";
import { defineCommand, ok, refuse } from "../command.js";
import { decimalInput, ensureAccount } from "../core/commands.js";
import { accountByExternalKey, accountByGid, profileOf } from "../core/queries.js";
import { calendarDate } from "../events/v1/primitives.js";
import type { Read } from "../query.js";
import { cleanNote, emitNote } from "./commands.js";

/** The live account holding this vehicle name; a removed holder starts a new account. */
export function vehicleAccount(read: Read, name: string) {
  const account = accountByExternalKey(read, "manual", `vehicle:${name}`);
  return account?.removed ? undefined : account;
}

export const setVehicle = defineCommand({
  id: "assets.setVehicle",
  input: z.object({
    name: z.string(),
    purchasePrice: decimalInput,
    purchaseDate: calendarDate,
    annualRate: decimalInput,
    floor: decimalInput.nullable().optional(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    /** The caller's local calendar date; the event clock is UTC. */
    asOf: calendarDate,
    note: z.string().nullable().optional(),
  }),
  run(ctx, input) {
    const note = cleanNote(input.note);
    if (note === "too_long") return refuse("note_too_long");
    // An invalid curve must not leave a newly created account or replace existing terms.
    const value = assets.depreciatedValue(
      D(input.purchasePrice),
      input.purchaseDate,
      D(input.annualRate),
      input.asOf,
      input.floor == null ? null : D(input.floor),
    );
    const account = ensureAccount(ctx, {
      bank: "manual",
      name: input.name,
      externalId: `vehicle:${input.name}`,
      type: "vehicle",
      currency: input.currency ?? profileOf(ctx.read)?.baseCurrency ?? "PLN",
    });
    ctx.emit("depreciation.set", ctx.det("depreciations", [account.gid]), {
      account: account.gid,
      purchasePrice: input.purchasePrice,
      purchaseDate: input.purchaseDate,
      annualRate: input.annualRate,
      floor: input.floor ?? null,
    });
    if (input.note !== undefined) emitNote(ctx, account.gid, note);
    return ok({
      account: account.gid,
      created: account.created,
      name: accountByGid(ctx.read, account.gid)?.name ?? (input.name || "manual"),
      currency: account.currency,
      value: value.format("f"),
    });
  },
});
