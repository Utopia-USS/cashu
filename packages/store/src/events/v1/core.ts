// Core payloads: profiles, modules, accounts, balances, budget settings (events.md 8.2).
import { z } from "zod";
import { empty, patchOf, payload } from "./helpers.js";
import { calendarDate, currency, decimal, gid, key, nonEmpty, timestamp } from "./primitives.js";

export const MCP_PRIVACY = ["strict", "amounts"] as const;
export const MODULE_IDS = ["budget", "assets", "loans", "investments"] as const;
/** Values of core.models.Source (Python stores the enum NAME in the DB; events use the value). */
export const BALANCE_SOURCES = ["open_banking", "csv", "manual", "connector"] as const;

export const coreEvents = {
  "profile.created": payload({
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    name: nonEmpty,
    baseCurrency: currency,
    mcpPrivacy: z.enum(MCP_PRIVACY),
    createdAt: timestamp.optional(),
  }),
  "profile.renamed": payload({ name: nonEmpty }),
  "profile.settingsChanged": patchOf({
    baseCurrency: currency,
    mcpPrivacy: z.enum(MCP_PRIVACY),
  }),

  "module.enabled": payload({ moduleId: z.enum(MODULE_IDS) }),
  "module.disabled": payload({ moduleId: z.enum(MODULE_IDS) }),

  "account.opened": payload({
    bank: nonEmpty,
    externalId: z.string().min(1).nullable(),
    iban: z.string().min(1).nullable(),
    currency,
    // Account type ids are registered by modules (core.account_types): a plain key, not an enum.
    type: key,
    name: nonEmpty,
    active: z.boolean().optional(),
    createdAt: timestamp.optional(),
  }),
  "account.renamed": payload({ name: nonEmpty }),
  "account.typeSet": payload({ type: key }),
  "account.removed": empty,
  "account.restored": empty,

  "balance.recorded": payload({
    account: gid,
    date: calendarDate,
    source: z.enum(BALANCE_SOURCES),
    amount: decimal,
    currency,
  }),

  "budgetSettings.cushionSet": payload({
    enabled: z.boolean(),
    currency: currency.nullable(),
    targetAmount: decimal.nullable(),
    targetMonths: z.int().min(1).nullable(),
    accounts: z.array(gid),
    monthlyMax: decimal.nullable(),
  }),
} as const;
