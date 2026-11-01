// TRANSITIONAL(S49): the sync bridge exists only while the Python app writes (S31a spec 2.1).
//
// Bridges of the core tables (S31a spec 4.4; events.md 8.2): profiles, profile modules, accounts and
// balances. Inserts are the genesis snapshot (`mapProfile`, `mapModule`, `mapAccount`, `mapBalance`);
// updates take every payload field from the genesis snapshot of `post`:
// - profiles: `name` -> `profile.renamed`; `base_currency` / `mcp_privacy` -> `profile.settingsChanged`
//   (changed fields only); slug and created_at never change;
// - profile modules: `enabled` -> `module.enabled` / `module.disabled` (`enabled_at` is derived);
// - accounts: `iban` / `external_id` filled (null -> value) -> `account.identified` with the phase-1
//   identity keys (S30 drops key parking before it reaches here); `name` -> `account.renamed`; `type`
//   -> `account.typeSet`; `removed_at` -> `account.removed` / `account.restored`; bank, currency,
//   active and created_at have no update event (Python never changes them): a change blocks;
// - balances: `upsert_balance` rewrites `amount` and `created_at` in place -> `balance.recorded`, the
//   whole value; its DET parts (account, date, source) and the currency never change.
// No core table has a delete event: Python deletes none of these rows.
import type { EventDraft, MapContext } from "../../genesis/map/context.js";
import { mapAccount, mapBalance, mapModule, mapProfile } from "../../genesis/map/core.js";
import type { AccountRow, BalanceRow, ProfileModuleRow, ProfileRow } from "../../genesis/rows.js";
import {
  anyChanged,
  BridgeBlock,
  carried,
  derived,
  eventsOf,
  fieldsOf,
  pick,
  type RowChange,
  type TableBridge,
} from "./types.js";

/** The decoded row of a change, or a block (the outbox values did not decode). */
export function need<R>(table: string, row: R | undefined): R {
  if (row === undefined) throw new BridgeBlock(`decode:${table}`);
  return row;
}

/** A change of a column the catalog has no update event for: block, never ship it half. */
export function refuseChanged(
  change: RowChange<unknown>,
  table: string,
  columns: readonly string[],
): void {
  for (const c of columns) {
    if (change.changed.has(c)) throw new BridgeBlock(`immutable:${table}:${c}`);
  }
}

/**
 * The events addressed to the row's own gid. A snapshot names the gid phase 1 gives the row today,
 * which for an account can differ from the gid it was opened with (an IBAN learned later, a minted
 * ULID instead of a genesis fallback); an update always addresses the existing row.
 */
export function onRow(gid: string, events: readonly EventDraft[]): readonly EventDraft[] {
  return events.map((e) => (e.gid === gid ? e : { ...e, gid }));
}

// ----------------------------------------------------------------------------------------------- //
// Profiles

/** Python column -> `profile.settingsChanged` patch field. */
const PROFILE_SETTINGS: readonly (readonly [string, string])[] = [
  ["base_currency", "baseCurrency"],
  ["mcp_privacy", "mcpPrivacy"],
];

function profileUpdate(c: RowChange<ProfileRow>, ctx: MapContext) {
  refuseChanged(c, "profiles", ["id", "slug", "created_at"]);
  const post = need("profiles", c.post);
  const snap = eventsOf(
    "profiles",
    ctx.attempt(() => mapProfile(post, ctx)),
  );
  const created = pick("profiles", snap, "profile.created");
  const out: EventDraft[] = [];
  if (c.changed.has("name")) {
    out.push(derived(created, "profile.renamed", fieldsOf(created.data, ["name"])));
  }
  const settings = PROFILE_SETTINGS.filter(([col]) => c.changed.has(col)).map(([, key]) => key);
  if (settings.length > 0) {
    out.push(derived(created, "profile.settingsChanged", fieldsOf(created.data, settings)));
  }
  return onRow(c.gid, out);
}

const profiles: TableBridge<ProfileRow> = {
  table: "profiles",
  gid: "vault",
  columns: {
    ...carried(["profile.created"], "id", "slug", "created_at"),
    ...carried(["profile.created", "profile.renamed"], "name"),
    ...carried(
      ["profile.created", "profile.settingsChanged"],
      ...PROFILE_SETTINGS.map(([col]) => col),
    ),
  },
  insert: (c, ctx) =>
    eventsOf(
      "profiles",
      ctx.attempt(() => mapProfile(need("profiles", c.post), ctx)),
    ),
  update: profileUpdate,
};

// ----------------------------------------------------------------------------------------------- //
// Profile modules

const profileModules: TableBridge<ProfileModuleRow> = {
  table: "profile_modules",
  gid: "det",
  columns: {
    ...carried(["module.enabled"], "profile_id", "module_id"),
    ...carried(["module.enabled", "module.disabled"], "enabled"),
  },
  insert: (c, ctx) =>
    eventsOf(
      "profile_modules",
      ctx.attempt(() => mapModule(need("profile_modules", c.post), ctx)),
    ),
  update: (c, ctx) => {
    refuseChanged(c, "profile_modules", ["profile_id", "module_id"]);
    if (!c.changed.has("enabled")) return [];
    const post = need("profile_modules", c.post);
    const snap = eventsOf(
      "profile_modules",
      ctx.attempt(() => mapModule(post, ctx)),
    );
    // The snapshot of a disabled module is enable + disable: the register's new value is the last.
    const type = post.enabled ? "module.enabled" : "module.disabled";
    return onRow(c.gid, [pick("profile_modules", snap, type)]);
  },
};

// ----------------------------------------------------------------------------------------------- //
// Accounts

/** Identifier columns `account.identified` fills (null -> value only, events.md 8.2). */
const IDENTIFIERS: readonly (readonly [string, "iban" | "externalId"])[] = [
  ["iban", "iban"],
  ["external_id", "externalId"],
];

function accountUpdate(c: RowChange<AccountRow>, ctx: MapContext) {
  refuseChanged(c, "accounts", ["id", "profile_id", "bank", "currency", "active", "created_at"]);
  const post = need("accounts", c.post);
  const pre = need("accounts", c.pre);
  const snap = eventsOf(
    "accounts",
    ctx.attempt(() => mapAccount(post, ctx)),
  );
  const opened = pick("accounts", snap, "account.opened");
  const out: EventDraft[] = [];

  const filled = IDENTIFIERS.filter(([col]) => c.changed.has(col));
  if (filled.length > 0) {
    for (const [col, field] of filled) {
      // The catalog only fills a missing identifier; Python never replaces or clears one (parking
      // and un-parking of `external_id` are dropped by S30's `_accounts_filter`).
      if (pre[field] !== null || post[field] === null) {
        throw new BridgeBlock(`immutable:accounts:${col}`);
      }
    }
    const keys = opened.data.keys;
    // An identifier that yields no identity key (an IBAN failing mod-97, a manual name key, a key
    // another account holds) has no event that carries it.
    if (!Array.isArray(keys) || keys.length === 0)
      throw new BridgeBlock("no-identity-key:accounts");
    const data = {
      ...fieldsOf(
        opened.data,
        filled.map(([, f]) => f),
      ),
      keys,
    };
    out.push(derived(opened, "account.identified", data));
  }
  if (c.changed.has("name")) {
    out.push(derived(opened, "account.renamed", fieldsOf(opened.data, ["name"])));
  }
  if (c.changed.has("type")) {
    out.push(derived(opened, "account.typeSet", fieldsOf(opened.data, ["type"])));
  }
  if (c.changed.has("removed_at")) {
    const removed = post.removedAt !== null;
    out.push(derived(opened, removed ? "account.removed" : "account.restored", {}));
  }
  return onRow(c.gid, out);
}

const accounts: TableBridge<AccountRow> = {
  table: "accounts",
  gid: "shipper",
  columns: {
    ...carried(["account.opened"], "id", "profile_id", "bank", "currency", "active", "created_at"),
    ...carried(["account.opened", "account.identified"], "iban", "external_id"),
    ...carried(["account.opened", "account.renamed"], "name"),
    ...carried(["account.opened", "account.typeSet"], "type"),
    ...carried(["account.opened", "account.removed", "account.restored"], "removed_at"),
  },
  // The phase-1 identity (`ctx.ids.accounts`) gives `keys` and the un-parked external id; the row's
  // gid is the one the dispatcher fixed (phase 1, or a minted ULID for a genesis fallback).
  insert: (c, ctx) =>
    onRow(
      c.gid,
      eventsOf(
        "accounts",
        ctx.attempt(() => mapAccount(need("accounts", c.post), ctx)),
      ),
    ),
  update: accountUpdate,
};

// ----------------------------------------------------------------------------------------------- //
// Balances

const BALANCE_KEY = ["id", "account_id", "date", "source"];

const balances: TableBridge<BalanceRow> = {
  table: "balances",
  gid: "det",
  columns: {
    ...carried(["balance.recorded"], ...BALANCE_KEY, "amount", "currency", "created_at"),
  },
  insert: (c, ctx) =>
    eventsOf(
      "balances",
      ctx.attempt(() => mapBalance(need("balances", c.post), ctx)),
    ),
  update: (c, ctx) => {
    // The currency is the first applied record's (events.md 8.1): a later one cannot change it.
    refuseChanged(c, "balances", [...BALANCE_KEY, "currency"]);
    if (!anyChanged(c, "amount", "created_at")) return [];
    const post = need("balances", c.post);
    return onRow(
      c.gid,
      eventsOf(
        "balances",
        ctx.attempt(() => mapBalance(post, ctx)),
      ),
    );
  },
};

export const coreBridges: readonly TableBridge[] = [profiles, profileModules, accounts, balances];
