// Core commands (S24 5): the profile, its modules, accounts and balances. Python oracles:
// `core/profiles.py` (create_profile, update_profile, set_modules), `core/accounts.py`
// (get_or_create_account, upsert_balance), `assets/service.py` (remove, restore).
import { Decimal, floatRepr, ibanKey, normalizeIban } from "@cashu/domain";
import {
  builtinRegistry,
  cleanCurrency,
  cleanModules,
  cleanName,
  cleanPrivacy,
} from "@cashu/domain/core";
import { z } from "zod";
import { type CommandContext, defineCommand, ok, refuse } from "../command.js";
import { BALANCE_SOURCES } from "../events/v1/core.js";
import { claimAllowed } from "../events/v1/identity.js";
import { calendarDate, decimal, gid } from "../events/v1/primitives.js";
import {
  type AccountView,
  accountByExternalKey,
  accountByGid,
  accountByIbanKey,
  accountByMemberGid,
  enabledModuleIds,
  profileOf,
} from "./queries.js";

const registry = builtinRegistry();

/**
 * External id prefixes derived from a name or random (gid.md 4.3): not identity, so the account
 * gets a ULID and claims no key, and a removed holder is never revived by a new open.
 */
const NAME_KEY_PREFIXES = ["manual:", "vehicle:", "brokerage:"];
const isNameKey = (externalId: string | null | undefined) =>
  externalId != null && NAME_KEY_PREFIXES.some((p) => externalId.startsWith(p));

/**
 * A decimal input as the plain-notation text events carry (Python `Decimal(str(value))`: a JSON
 * integer as an int, `700000`; any other number as a float, `repr` digits).
 */
export const decimalInput = z
  .union([decimal, z.number().finite()])
  .transform((v) =>
    typeof v !== "number"
      ? v
      : Number.isSafeInteger(v)
        ? String(v)
        : Decimal.parse(floatRepr(v)).format("f"),
  );

export interface AccountSpec {
  readonly bank: string;
  readonly name?: string | null;
  readonly type: string;
  readonly currency: string;
  readonly iban?: string | null;
  readonly externalId?: string | null;
}

export interface EnsuredAccount {
  readonly gid: string;
  readonly created: boolean;
  readonly currency: string;
  readonly type: string;
}

/**
 * Python `get_or_create_account` as events (events.md 8.2, gid.md 4.3): look the view up by IBAN
 * key, then by (bank, external id); a found account learns the identifiers it lacks
 * (`account.identified` with the new keys only, nothing when it knows them), else
 * `account.opened` with the DET gid of its IBAN or natural key (a ULID for name keys).
 */
export function ensureAccount(ctx: CommandContext, spec: AccountSpec): EnsuredAccount {
  const iban = normalizeIban(spec.iban) || null;
  const key = ibanKey(iban);
  const nameKey = isNameKey(spec.externalId);
  const externalId = spec.externalId || (iban ? `csv:${iban}` : null);
  const natural = externalId !== null && !isNameKey(externalId);
  // By IBAN key (identity key, else a raw IBAN shown without one), then by the IBAN's DET gid (an IBAN
  // failing the checksum never becomes an identity key, N2, but its account still has that gid), then
  // by (bank, external id).
  let found: AccountView | undefined = key
    ? (accountByIbanKey(ctx.read, key) ??
      accountByMemberGid(ctx.read, ctx.det("accounts", ["iban", key])))
    : undefined;
  if (found === undefined && externalId !== null) {
    const byKey =
      accountByExternalKey(ctx.read, spec.bank, externalId) ??
      (natural
        ? accountByMemberGid(ctx.read, ctx.det("accounts", ["ext", spec.bank, externalId]))
        : undefined);
    // a removed holder of a name key is parked aside, never revived (park_removed_key)
    if (byKey !== undefined && !(nameKey && byKey.removed)) found = byKey;
  }
  if (found !== undefined) {
    const keys: string[] = [];
    const data: Record<string, unknown> = {};
    // the account learns a valid IBAN while it holds no identity IBAN (a raw one may be shown)
    if (iban && found.ibanKey === null && claimAllowed(`iban:${key}`, iban)) {
      keys.push(`iban:${key}`);
      data.iban = iban;
    }
    if (spec.externalId && !nameKey && found.externalId !== spec.externalId) {
      keys.push(`ext:${spec.bank}:${spec.externalId}`);
      if (found.externalId === null) data.externalId = spec.externalId;
    }
    if (keys.length > 0) ctx.emit("account.identified", found.gid, { ...data, keys });
    return { gid: found.gid, created: false, currency: found.currency, type: found.type };
  }
  const gidOf = iban
    ? ctx.det("accounts", ["iban", key])
    : natural
      ? ctx.det("accounts", ["ext", spec.bank, externalId])
      : ctx.newGid();
  const keys: string[] = [];
  if (iban && claimAllowed(`iban:${key}`, iban)) keys.push(`iban:${key}`);
  if (natural) keys.push(`ext:${spec.bank}:${externalId}`);
  ctx.emit("account.opened", gidOf, {
    bank: spec.bank,
    externalId,
    iban,
    currency: spec.currency,
    type: spec.type,
    name: spec.name || `${spec.bank} ${iban ? iban.slice(-4) : ""}`.trim(),
    keys,
  });
  return { gid: gidOf, created: true, currency: spec.currency, type: spec.type };
}

/** The visible (not removed) account `gid`, or undefined. */
export function visibleAccount(ctx: CommandContext, account: string): AccountView | undefined {
  const a = accountByGid(ctx.read, account);
  return a === undefined || a.removed ? undefined : a;
}

// ------------------------------------------------------------------------------- profile

export const createProfile = defineCommand({
  id: "core.createProfile",
  input: z.object({
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    name: z.string(),
    baseCurrency: z.string().default("PLN"),
    mcpPrivacy: z.string().default("strict"),
    modules: z.array(z.string()).default([]),
  }),
  run(ctx, input) {
    if (profileOf(ctx.read) !== undefined) return refuse("exists");
    const name = cleanName(input.name);
    if (!name.ok) return refuse("invalid_name");
    const currency = cleanCurrency(input.baseCurrency);
    if (!currency.ok) return refuse("invalid_currency");
    const privacy = cleanPrivacy(input.mcpPrivacy);
    if (!privacy.ok) return refuse("invalid_privacy");
    const modules = cleanModules(registry, input.modules);
    if (!modules.ok) return refuse("unknown_module");
    ctx.emit("profile.created", ctx.vault, {
      slug: input.slug,
      name: name.value,
      baseCurrency: currency.value,
      mcpPrivacy: privacy.value,
    });
    for (const m of modules.value) {
      ctx.emit("module.enabled", ctx.det("profile_modules", [m]), { moduleId: m });
    }
    return ok({ modules: modules.value });
  },
});

export const renameProfile = defineCommand({
  id: "core.renameProfile",
  input: z.object({ name: z.string() }),
  run(ctx, input) {
    const profile = profileOf(ctx.read);
    if (profile === undefined) return refuse("no_profile");
    const name = cleanName(input.name);
    if (!name.ok) return refuse("invalid_name");
    if (name.value !== profile.name) ctx.emit("profile.renamed", ctx.vault, { name: name.value });
    return ok(null);
  },
});

export const setProfileSettings = defineCommand({
  id: "core.setProfileSettings",
  input: z.object({ baseCurrency: z.string().optional(), mcpPrivacy: z.string().optional() }),
  run(ctx, input) {
    const profile = profileOf(ctx.read);
    if (profile === undefined) return refuse("no_profile");
    const patch: Record<string, string> = {};
    if (input.baseCurrency !== undefined) {
      const c = cleanCurrency(input.baseCurrency);
      if (!c.ok) return refuse("invalid_currency");
      if (c.value !== profile.baseCurrency) patch.baseCurrency = c.value;
    }
    if (input.mcpPrivacy !== undefined) {
      const p = cleanPrivacy(input.mcpPrivacy);
      if (!p.ok) return refuse("invalid_privacy");
      if (p.value !== profile.mcpPrivacy) patch.mcpPrivacy = p.value;
    }
    if (Object.keys(patch).length > 0) ctx.emit("profile.settingsChanged", ctx.vault, patch);
    return ok(null);
  },
});

/** Enable exactly `moduleIds` plus their dependencies; only registers that change emit. */
export const setModules = defineCommand({
  id: "core.setModules",
  input: z.object({ moduleIds: z.array(z.string()) }),
  run(ctx, input) {
    const wanted = cleanModules(registry, input.moduleIds);
    if (!wanted.ok) return refuse("unknown_module");
    const want = new Set(wanted.value);
    const enabled = enabledModuleIds(ctx.read);
    for (const m of registry.modules.keys()) {
      const gidOf = ctx.det("profile_modules", [m]);
      if (want.has(m) && !enabled.has(m)) ctx.emit("module.enabled", gidOf, { moduleId: m });
      if (!want.has(m) && enabled.has(m)) ctx.emit("module.disabled", gidOf, { moduleId: m });
    }
    return ok({ modules: wanted.value });
  },
});

// ------------------------------------------------------------------------------- accounts

const accountType = z.string().refine((t) => registry.accountTypes.ids().includes(t));

export const openAccount = defineCommand({
  id: "core.openAccount",
  input: z.object({
    bank: z.string().regex(/^[a-z0-9_-]+$/),
    name: z.string().nullable().optional(),
    type: accountType,
    currency: z.string().regex(/^[A-Z]{3}$/),
    iban: z.string().nullable().optional(),
    externalId: z.string().min(1).nullable().optional(),
  }),
  run(ctx, input) {
    const a = ensureAccount(ctx, input);
    return ok({ account: a.gid, created: a.created });
  },
});

const accountRef = z.object({ account: gid });

export const renameAccount = defineCommand({
  id: "core.renameAccount",
  input: accountRef.extend({ name: z.string() }),
  run(ctx, input) {
    const a = accountByGid(ctx.read, input.account);
    if (a === undefined) return refuse("no_account");
    const name = cleanName(input.name);
    if (!name.ok) return refuse("invalid_name");
    if (name.value !== a.name) ctx.emit("account.renamed", a.gid, { name: name.value });
    return ok(null);
  },
});

export const setAccountType = defineCommand({
  id: "core.setAccountType",
  input: accountRef.extend({ type: z.string() }),
  run(ctx, input) {
    const a = accountByGid(ctx.read, input.account);
    if (a === undefined) return refuse("no_account");
    if (!registry.accountTypes.ids().includes(input.type)) return refuse("unknown_type");
    if (input.type !== a.type) ctx.emit("account.typeSet", a.gid, { type: input.type });
    return ok(null);
  },
});

/** Hide an account from every view (idempotent; Python `assets.service.remove`). */
export const removeAccount = defineCommand({
  id: "core.removeAccount",
  input: accountRef,
  run(ctx, input) {
    const a = accountByGid(ctx.read, input.account);
    if (a === undefined) return refuse("no_account");
    if (!a.removed) ctx.emit("account.removed", a.gid, {});
    return ok(null);
  },
});

/** Bring a removed account back (idempotent); its name key comes back by derivation (D-24.7). */
export const restoreAccount = defineCommand({
  id: "core.restoreAccount",
  input: accountRef,
  run(ctx, input) {
    const a = accountByGid(ctx.read, input.account);
    if (a === undefined) return refuse("no_account");
    if (a.removed) ctx.emit("account.restored", a.gid, {});
    return ok(null);
  },
});

/** Emit one balance snapshot of `account` (Python `upsert_balance`: currency default = account's). */
export function emitBalance(
  ctx: CommandContext,
  account: string,
  date: string,
  source: (typeof BALANCE_SOURCES)[number],
  amount: string,
  currency: string,
): void {
  ctx.emit("balance.recorded", ctx.det("balances", [account, date, source]), {
    account,
    date,
    source,
    amount,
    currency,
  });
}

export const recordBalance = defineCommand({
  id: "core.recordBalance",
  input: accountRef.extend({
    date: calendarDate,
    source: z.enum(BALANCE_SOURCES).default("manual"),
    amount: decimalInput,
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
  }),
  run(ctx, input) {
    const a = accountByGid(ctx.read, input.account);
    if (a === undefined) return refuse("no_account");
    emitBalance(ctx, a.gid, input.date, input.source, input.amount, input.currency ?? a.currency);
    return ok(null);
  },
});
