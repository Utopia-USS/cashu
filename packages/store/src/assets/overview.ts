/** Dashboard asset creation keeps the API's create semantics without changing CLI upserts. */
import { assets, D } from "@cashu/domain";
import { z } from "zod";
import { defineCommand, refuse } from "../command.js";
import { decimalInput, removeAccount, restoreAccount } from "../core/commands.js";
import { type AccountView, accountByExternalKey, accountByGid } from "../core/queries.js";
import { calendarDate, gid } from "../events/v1/primitives.js";
import { addManualPosition, assetUiToday, cleanNote } from "./commands.js";
import { setVehicle } from "./vehicle.js";

const curve = z.object({
  purchasePrice: decimalInput,
  purchaseDate: calendarDate,
  annualRate: decimalInput,
  floor: decimalInput.nullable().optional(),
});

/** A single append for a new position, its curve or valuation, and its optional note. */
export const createOverviewAsset = defineCommand({
  id: "assets.createOverviewAsset",
  input: z.object({
    name: z.string(),
    type: z.enum(["property", "vehicle", "investment", "other"]),
    value: decimalInput.optional(),
    curve: curve.optional(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    onDate: calendarDate.optional(),
    note: z.string().nullable().optional(),
  }),
  run(ctx, input) {
    const name = input.name.split(/\s+/u).filter(Boolean).join(" ");
    if (name.length === 0 || Array.from(name).length > 120) return refuse("invalid_name");
    const existing = [
      accountByExternalKey(ctx.read, "manual", `manual:${name}`),
      accountByExternalKey(ctx.read, "manual", `vehicle:${name}`),
    ];
    if (existing.some((account) => account !== undefined && !account.removed))
      return refuse("name_taken");
    if (cleanNote(input.note) === "too_long") return refuse("note_too_long");
    if (input.type === "vehicle") {
      const terms = input.curve;
      if (terms === undefined) return refuse("invalid_depreciation");
      const price = D(terms.purchasePrice);
      if (
        price.lte(D("0")) ||
        terms.purchaseDate > assetUiToday(ctx.now()) ||
        D(terms.annualRate).lt(D("0")) ||
        D(terms.annualRate).gt(D("100")) ||
        (terms.floor != null && (D(terms.floor).lt(D("0")) || D(terms.floor).gt(price)))
      )
        return refuse("invalid_depreciation");
      return setVehicle.run(ctx, {
        name,
        purchasePrice: terms.purchasePrice,
        purchaseDate: terms.purchaseDate,
        annualRate: terms.annualRate,
        floor: terms.floor ?? null,
        currency: input.currency,
        asOf: assetUiToday(ctx.now()),
        note: input.note,
      });
    }
    if (input.value === undefined || D(input.value).lt(D("0"))) return refuse("invalid_valuation");
    return addManualPosition.run(ctx, {
      name,
      type: input.type,
      value: input.value,
      currency: input.currency,
      onDate: input.onDate,
      note: input.note,
    });
  },
});

const isAsset = (account: AccountView | undefined): account is AccountView =>
  account !== undefined && assets.isModuleAccount(account);

/** The drawer cannot remove a bank, brokerage or loan account through a generic core command. */
export const removeOverviewAsset = defineCommand({
  id: "assets.removeOverviewAsset",
  input: z.object({ account: gid }),
  run(ctx, input) {
    const account = accountByGid(ctx.read, input.account);
    if (!isAsset(account) || account.removed) return refuse("no_asset");
    return removeAccount.run(ctx, input);
  },
});

export const restoreOverviewAsset = defineCommand({
  id: "assets.restoreOverviewAsset",
  input: z.object({ account: gid }),
  run(ctx, input) {
    const account = accountByGid(ctx.read, input.account);
    if (!isAsset(account) || !account.removed) return refuse("no_asset");
    return restoreAccount.run(ctx, input);
  },
});
