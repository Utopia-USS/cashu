// Core payloads: profiles, modules, accounts, balances, budget settings (events.md 8.2).
import { z } from "zod";
import { empty, patchOf, payload } from "./helpers.js";
import { calendarDate, currency, decimal, gid, key, nonEmpty } from "./primitives.js";

export const MCP_PRIVACY = ["strict", "amounts"] as const;
export const MODULE_IDS = ["budget", "assets", "loans", "investments"] as const;
/** Values of core.models.Source (Python stores the enum NAME in the DB; events use the value). */
export const BALANCE_SOURCES = ["open_banking", "csv", "manual", "connector"] as const;

/**
 * An account identity key (gid.md 4.3): `iban:<iban_key>` (core/text.py iban_key: normalized, the
 * country prefix stripped, so the CSV NRB and the Open Banking IBAN agree) or
 * `ext:<bank>:<external natural key>` (Enable Banking uid, `csv:<IBAN>`, a statement key, `cash:<CUR>`).
 * Two accounts claiming one key are one account (identity resolution, events.md 6.4).
 */
export const accountKey = z
  .string()
  .regex(/^(iban:[0-9A-Z]+|ext:[a-z0-9_-]+:.+)$/, "expected iban:<key> or ext:<bank>:<key>");

export const coreEvents = {
  "profile.created": payload({
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    name: nonEmpty,
    baseCurrency: currency,
    mcpPrivacy: z.enum(MCP_PRIVACY),
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
    /** Identity keys this account claims (may be empty for manual / brokerage accounts). */
    keys: z.array(accountKey),
  }),
  /**
   * The account learned an identifier (an IBAN from Open Banking or a statement, a new Enable Banking
   * uid after re-consent): fills `iban` / `externalId` when still null (first non-null by hlc wins) and
   * claims `keys`. A key already held by another account merges the two (events.md 6.4).
   */
  "account.identified": payload({
    iban: z.string().min(1).optional(),
    externalId: z.string().min(1).optional(),
    keys: z.array(accountKey).min(1),
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
