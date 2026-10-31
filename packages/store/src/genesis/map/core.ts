// Genesis row mappers, core (S26 spec 4.1; events.md 8.2; gid.md 4.1-4.3, 4.5, 7): the profile, its
// modules, accounts (un-parked external id and identity keys from phase 1) and balances.
import type { AccountRow, BalanceRow, ProfileModuleRow, ProfileRow } from "../rows.js";
import {
  event,
  gidOf,
  type MapContext,
  type RowEvents,
  requiredGid,
  rowEvents,
  stampsOf,
} from "./context.js";

/** `profile.created`: the gid is the vault id (gid.md 4.1). */
export function mapProfile(r: ProfileRow, ctx: MapContext): RowEvents | undefined {
  const gid = gidOf(ctx, "profiles", r.id);
  if (gid === undefined) return undefined;
  const data = {
    slug: r.slug,
    name: r.name,
    baseCurrency: r.baseCurrency,
    mcpPrivacy: r.mcpPrivacy,
  };
  return rowEvents("profiles", r.id, [
    event("profile.created", gid, data, stampsOf(r, ["createdAt"])),
  ]);
}

/** `module.enabled`, then `module.disabled` for a module switched off (one LWW register). */
export function mapModule(r: ProfileModuleRow, ctx: MapContext): RowEvents | undefined {
  const localId = `${r.profileId}|${r.moduleId}`;
  const gid = gidOf(ctx, "profile_modules", localId);
  if (gid === undefined) return undefined;
  const stamps = stampsOf(r, ["enabledAt"]);
  const data = { moduleId: r.moduleId };
  const events = [event("module.enabled", gid, data, stamps)];
  if (!r.enabled) events.push(event("module.disabled", gid, data, stamps));
  return rowEvents("profile_modules", localId, events);
}

/** `account.opened` with the phase-1 identity, then `account.removed` for a removed account. */
export function mapAccount(r: AccountRow, ctx: MapContext): RowEvents | undefined {
  const identity = ctx.ids.accounts.get(r.id);
  if (identity === undefined) return undefined;
  const stamps = stampsOf(r, ["createdAt", "removedAt"]);
  const opened = {
    bank: r.bank,
    externalId: identity.externalId,
    iban: r.iban,
    currency: r.currency,
    type: r.type,
    name: r.name,
    active: r.active,
    keys: identity.keys,
  };
  const events = [event("account.opened", identity.gid, opened, stamps)];
  if (r.removedAt !== null) events.push(event("account.removed", identity.gid, {}, stamps));
  return rowEvents("accounts", r.id, events);
}

/** `balance.recorded` (gid DET[@account, date, source]). */
export function mapBalance(r: BalanceRow, ctx: MapContext): RowEvents | undefined {
  const gid = gidOf(ctx, "balances", r.id);
  if (gid === undefined) return undefined;
  const data = {
    account: requiredGid(ctx, "accounts", r.accountId),
    date: r.date,
    source: r.source,
    amount: r.amount,
    currency: r.currency,
  };
  return rowEvents("balances", r.id, [
    event("balance.recorded", gid, data, stampsOf(r, ["createdAt"])),
  ]);
}
