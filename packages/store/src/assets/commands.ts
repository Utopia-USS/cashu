// Assets commands (S24 5). Python oracle: `assets/service.py` (add_manual_position, set_note,
// set_depreciation) and `core/accounts.py` (set_balance). A manual position is a core account
// (`manual:<name>` name key, ULID gid, no identity key) with manual balance snapshots.

import { z } from "zod";
import { type CommandContext, defineCommand, ok, refuse } from "../command.js";
import { decimalInput, emitBalance, ensureAccount, visibleAccount } from "../core/commands.js";
import { profileOf } from "../core/queries.js";
import { ASSET_NOTE_MAX } from "../events/v1/assets-loans.js";
import { calendarDate, gid } from "../events/v1/primitives.js";

/** Python `clean_note`: one line, whitespace folded, empty -> null, at most 500 characters. */
export function cleanNote(note: string | null | undefined): string | null | "too_long" {
  if (note === null || note === undefined) return null;
  const text = note
    .split(/\s+/u)
    .filter((w) => w !== "")
    .join(" ");
  if (text === "") return null;
  return Array.from(text).length > ASSET_NOTE_MAX ? "too_long" : text;
}

/** Emit the note of `account` (no event for a null note while it has no note row, D-24.9). */
function emitNote(ctx: CommandContext, account: string, note: string | null): void {
  if (note === null) {
    const row = ctx.read(
      "SELECT 1 AS x FROM asset_details d JOIN accounts a ON a.id = d.account_id WHERE a.gid = ?",
      account,
    );
    if (row.length === 0) return;
  }
  ctx.emit("assetDetails.noteSet", ctx.det("asset_details", [account]), { account, note });
}

/**
 * A manually valued position (Python `add_manual_position`): the live account holding the name key,
 * else a new one (a removed holder is never revived, D-24.7), and its value as a manual balance of
 * `onDate` (today by default); `note` replaces the stored note when given.
 */
export const addManualPosition = defineCommand({
  id: "assets.addManualPosition",
  input: z.object({
    name: z.string().min(1),
    type: z.string().regex(/^[a-z][a-z0-9_]*$/),
    value: decimalInput,
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    onDate: calendarDate.optional(),
    note: z.string().nullable().optional(),
  }),
  run(ctx, input) {
    const note = cleanNote(input.note);
    if (note === "too_long") return refuse("note_too_long");
    const base = profileOf(ctx.read)?.baseCurrency ?? "PLN";
    const a = ensureAccount(ctx, {
      bank: "manual",
      name: input.name,
      externalId: `manual:${input.name}`,
      type: input.type,
      currency: input.currency ?? base,
    });
    emitBalance(ctx, a.gid, input.onDate ?? ctx.today(), "manual", input.value, a.currency);
    if (input.note !== undefined && input.note !== null) emitNote(ctx, a.gid, note);
    return ok({ account: a.gid, created: a.created });
  },
});

export const setNote = defineCommand({
  id: "assets.setNote",
  input: z.object({ account: gid, note: z.string().nullable() }),
  run(ctx, input) {
    const a = visibleAccount(ctx, input.account);
    if (a === undefined) return refuse("no_account");
    const note = cleanNote(input.note);
    if (note === "too_long") return refuse("note_too_long");
    emitNote(ctx, a.gid, note);
    return ok({ note });
  },
});

export const setDepreciation = defineCommand({
  id: "assets.setDepreciation",
  input: z.object({
    account: gid,
    purchasePrice: decimalInput,
    purchaseDate: calendarDate,
    annualRate: decimalInput,
    floor: decimalInput.nullable().optional(),
  }),
  run(ctx, input) {
    const a = visibleAccount(ctx, input.account);
    if (a === undefined) return refuse("no_account");
    ctx.emit("depreciation.set", ctx.det("depreciations", [a.gid]), {
      account: a.gid,
      purchasePrice: input.purchasePrice,
      purchaseDate: input.purchaseDate,
      annualRate: input.annualRate,
      floor: input.floor ?? null,
    });
    return ok(null);
  },
});

/** A new value of a position (Python `set_balance`, source manual). */
export const revalue = defineCommand({
  id: "assets.revalue",
  input: z.object({ account: gid, value: decimalInput, onDate: calendarDate.optional() }),
  run(ctx, input) {
    const a = visibleAccount(ctx, input.account);
    if (a === undefined) return refuse("no_account");
    emitBalance(ctx, a.gid, input.onDate ?? ctx.today(), "manual", input.value, a.currency);
    return ok(null);
  },
});
