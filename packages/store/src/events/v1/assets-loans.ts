// Loans and assets payloads (events.md 8.4).
import { z } from "zod";
import { payload } from "./helpers.js";
import { calendarDate, decimal, gid } from "./primitives.js";

/** `assets.models.NOTE_MAX`. */
export const ASSET_NOTE_MAX = 500;

export const assetsLoansEvents = {
  "loan.termsSet": payload({
    account: gid,
    principal: decimal,
    annualRate: decimal,
    termMonths: z.int().min(1),
    startDate: calendarDate,
    originationDate: calendarDate.nullable(),
  }),
  "loan.paymentMatchingSet": payload({
    paymentIban: z.string().min(1).nullable(),
    paymentText: z.string().min(1).nullable(),
  }),
  "depreciation.set": payload({
    account: gid,
    purchasePrice: decimal,
    purchaseDate: calendarDate,
    annualRate: decimal,
    floor: decimal.nullable(),
  }),
  "assetDetails.noteSet": payload({
    account: gid,
    note: z.string().max(ASSET_NOTE_MAX).nullable(),
  }),
} as const;
