// Budget payloads: bank transactions, category claims, merchant rules, import batches (events.md 8.3).
import { z } from "zod";
import { BALANCE_SOURCES } from "./core.js";
import { empty, payload } from "./helpers.js";
import {
  blobRef,
  calendarDate,
  currency,
  decimal,
  gid,
  jsonObject,
  key,
  nonEmpty,
  sha1Hex,
  timestamp,
} from "./primitives.js";

/** Per-transaction category claims (D8). `llm_fallback` is a legacy value, genesis only. */
export const TXN_CLAIM_SOURCES = ["manual_txn", "llm_full", "llm_fallback"] as const;
export const RULE_SOURCES = ["manual", "llm"] as const;

export const budgetEvents = {
  "txn.imported": payload({
    account: gid,
    batch: gid.nullable(),
    bookingDate: calendarDate,
    valueDate: calendarDate.nullable(),
    amount: decimal,
    currency,
    counterpartyName: z.string().nullable(),
    counterpartyIban: z.string().nullable(),
    description: z.string().nullable(),
    reference: z.string().nullable(),
    bankTransactionId: z.string().nullable(),
    source: z.enum(BALANCE_SOURCES),
    /** dedupHashV2 (gid.md 4.4): sha1 of the account-free content key; legacy genesis rows use `legacy:<v1>`. */
    dedupHash: z.union([sha1Hex, z.string().regex(/^legacy:[0-9a-f]{40}$/)]),
    occurrence: z.int().min(0),
    raw: jsonObject,
  }),
  "txn.cashExpenseAdded": payload({
    account: gid,
    bookingDate: calendarDate,
    amount: decimal.refine(
      (s) => s.startsWith("-") && /[1-9]/.test(s),
      "a cash expense is negative",
    ),
    currency,
    title: nonEmpty,
    category: key,
  }),
  "txn.categorySet": payload({ category: key, source: z.enum(TXN_CLAIM_SOURCES) }),
  "txn.categoryCleared": empty,
  "txn.deleted": empty,

  "transferRun.started": payload({
    reset: z.boolean(),
    maxDays: z.int(),
    pairCount: z.int().min(0),
  }),
  "transferPair.claimed": payload({ run: gid, out: gid, in: gid, ordinal: z.int().min(0) }),

  "categoryRule.set": payload({
    merchantKey: nonEmpty,
    category: key,
    source: z.enum(RULE_SOURCES),
    locked: z.boolean(),
  }),

  "importBatch.recorded": payload({
    source: z.enum(BALANCE_SOURCES),
    bank: z.string().nullable(),
    account: gid.nullable(),
    filename: z.string().nullable(),
    startedAt: timestamp,
    finishedAt: timestamp.nullable(),
    numSeen: z.int().min(0),
    numInserted: z.int().min(0),
    numDuplicates: z.int().min(0),
    notes: z.string().nullable(),
    archive: blobRef.optional(),
  }),
} as const;
