// Accounts: identity (events.md 6.4, gid.md 4.3) and the `accounts` view.
//
// Identity: `account.opened` / `account.identified` claim their `keys`; an `iban:` key only with a
// checksum-valid IBAN whose key equals the claim, and at most one `iban:` key per component (N2).
// Row: keyed by the identity root (the row gid). `iban` = the component's first accepted IBAN;
// `external_id` = first non-null; `type` = latest `account.typeSet`, else the first applied open's;
// `name` = latest explicit rename of any member, else the root's own opened name, else the first
// applied open's (N4); `removed_at` = SOFT register.
import type {
  FoldContext,
  FoldEvent,
  IdentityClaim,
  IdentityConflict,
  IdentityKind,
  Materializer,
  ViewSql,
} from "../engine/types.js";
import { claimAllowed } from "../events/v1/identity.js";
import type { TableDef } from "../sql/ddl.js";
import { sqlBool } from "../sql/values.js";

export const ACCOUNTS = "accounts";

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

const conflictsTable: TableDef = {
  name: "account_conflicts",
  primaryKey: ["seq"],
  columns: [
    { name: "seq", type: "INTEGER", notNull: true },
    { name: "eid", type: "TEXT", notNull: true },
    { name: "account_gid", type: "TEXT", notNull: true },
    { name: "key", type: "TEXT" },
    { name: "reason", type: "TEXT", notNull: true },
  ],
};

export const accountIdentity: IdentityKind = {
  id: ACCOUNTS,
  version: 1,
  handles: ["account.opened", "account.identified"],
  exclusivePrefix: "iban:",
  tables: [conflictsTable],
  claims(e: FoldEvent): IdentityClaim[] {
    const keys = (e.data.keys as string[] | undefined) ?? [];
    const iban = str(e.data.iban);
    return keys
      .filter((k) => claimAllowed(k, e.data.iban))
      .map((k) =>
        k.startsWith("iban:") && iban !== null
          ? { gid: e.gid, key: k, value: iban }
          : { gid: e.gid, key: k },
      );
  },
  merges: () => [],
  writeConflicts(conflicts: readonly IdentityConflict[], sql: ViewSql) {
    sql.write(conflictsTable.name, "DELETE FROM account_conflicts");
    conflicts.forEach((c, i) => {
      sql.write(
        conflictsTable.name,
        "INSERT INTO account_conflicts (seq, eid, account_gid, key, reason) VALUES (?, ?, ?, ?, ?)",
        i,
        c.eid,
        c.gid,
        c.key,
        c.reason,
      );
    });
  },
};

const accountsTable: TableDef = {
  name: "accounts",
  columns: [
    { name: "bank", type: "TEXT", notNull: true },
    { name: "name", type: "TEXT", notNull: true },
    { name: "iban", type: "TEXT" },
    { name: "external_id", type: "TEXT" },
    { name: "currency", type: "TEXT", notNull: true },
    { name: "type", type: "TEXT", notNull: true },
    { name: "active", type: "INTEGER", notNull: true },
    { name: "created_at", type: "TEXT", notNull: true },
    { name: "removed_at", type: "TEXT" },
  ],
  indexes: [{ columns: ["iban"] }, { columns: ["external_id"] }],
};

/** Per-root fold registers; the public row is projected from it after every event. */
const foldTable: TableDef = {
  name: "fold_accounts",
  primaryKey: ["root"],
  internal: true,
  columns: [
    { name: "root", type: "TEXT", notNull: true },
    { name: "bank", type: "TEXT" },
    { name: "currency", type: "TEXT" },
    { name: "open_type", type: "TEXT" },
    { name: "set_type", type: "TEXT" },
    { name: "active", type: "INTEGER" },
    { name: "first_name", type: "TEXT" },
    { name: "own_name", type: "TEXT" },
    { name: "renamed", type: "TEXT" },
    { name: "iban", type: "TEXT" },
    { name: "external_id", type: "TEXT" },
    { name: "created_at", type: "TEXT" },
    { name: "removed_at", type: "TEXT" },
  ],
};

interface AccountState {
  root: string;
  bank: string | null;
  currency: string | null;
  open_type: string | null;
  set_type: string | null;
  active: number | null;
  first_name: string | null;
  own_name: string | null;
  renamed: string | null;
  iban: string | null;
  external_id: string | null;
  created_at: string | null;
  removed_at: string | null;
}

function load(ctx: FoldContext, root: string): AccountState {
  return (
    ctx.sql.get<AccountState>("SELECT * FROM fold_accounts WHERE root = ?", root) ?? {
      root,
      bank: null,
      currency: null,
      open_type: null,
      set_type: null,
      active: null,
      first_name: null,
      own_name: null,
      renamed: null,
      iban: null,
      external_id: null,
      created_at: null,
      removed_at: null,
    }
  );
}

function save(ctx: FoldContext, s: AccountState): void {
  ctx.sql.write(
    foldTable.name,
    `INSERT OR REPLACE INTO fold_accounts (root, bank, currency, open_type, set_type, active, first_name,
       own_name, renamed, iban, external_id, created_at, removed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    s.root,
    s.bank,
    s.currency,
    s.open_type,
    s.set_type,
    s.active,
    s.first_name,
    s.own_name,
    s.renamed,
    s.iban,
    s.external_id,
    s.created_at,
    s.removed_at,
  );
  // The row is visible once an open of any member is folded (bank / currency / name known).
  if (s.bank === null || s.currency === null || s.open_type === null) return;
  ctx.sql.write(
    accountsTable.name,
    `INSERT INTO accounts (id, gid, bank, name, iban, external_id, currency, type, active, created_at, removed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (gid) DO UPDATE SET bank = excluded.bank, name = excluded.name, iban = excluded.iban,
       external_id = excluded.external_id, currency = excluded.currency, type = excluded.type,
       active = excluded.active, created_at = excluded.created_at, removed_at = excluded.removed_at
     WHERE accounts.name IS NOT excluded.name OR accounts.iban IS NOT excluded.iban
       OR accounts.external_id IS NOT excluded.external_id OR accounts.type IS NOT excluded.type
       OR accounts.removed_at IS NOT excluded.removed_at OR accounts.active IS NOT excluded.active`,
    ctx.id(s.root),
    s.root,
    s.bank,
    s.renamed ?? s.own_name ?? s.first_name ?? "",
    s.iban,
    s.external_id,
    s.currency,
    s.set_type ?? s.open_type,
    s.active ?? 1,
    s.created_at ?? "",
    s.removed_at,
  );
}

export const accountsMaterializer: Materializer = {
  id: "core.accounts",
  version: 1,
  tables: [accountsTable, foldTable],
  handles: [
    "account.opened",
    "account.identified",
    "account.renamed",
    "account.typeSet",
    "account.removed",
    "account.restored",
  ],
  identity: [ACCOUNTS],
  accepted: [ACCOUNTS],
  partitions: (e, ctx) => [ctx.resolve(ACCOUNTS, e.gid)],
  subjects: (root, ctx) => ctx.identityMembers(ACCOUNTS, root),
  clear(roots, ctx) {
    for (const r of roots) {
      ctx.sql.write(accountsTable.name, "DELETE FROM accounts WHERE gid = ?", r);
      ctx.sql.write(foldTable.name, "DELETE FROM fold_accounts WHERE root = ?", r);
    }
  },
  apply(e, ctx) {
    const root = ctx.resolve(ACCOUNTS, e.gid);
    const s = load(ctx, root);
    const d = e.data;
    switch (e.type) {
      case "account.opened":
      case "account.identified": {
        const accepted = ctx.accepted(ACCOUNTS, e.eid);
        if (s.iban === null && accepted !== undefined) s.iban = accepted;
        if (s.external_id === null) s.external_id = str(d.externalId);
        if (e.type === "account.opened") {
          if (s.bank === null) {
            // the first applied open supplies the initial values (CREATE)
            s.bank = str(d.bank);
            s.currency = str(d.currency);
            s.open_type = str(d.type);
            s.active = sqlBool(d.active !== false);
            s.first_name = str(d.name);
            s.created_at = ctx.time(e, "created_at");
          }
          if (e.gid === root && s.own_name === null) s.own_name = str(d.name);
        }
        break;
      }
      case "account.renamed":
        s.renamed = str(d.name);
        break;
      case "account.typeSet":
        s.set_type = str(d.type);
        break;
      case "account.removed":
        s.removed_at = ctx.time(e, "removed_at");
        break;
      case "account.restored":
        s.removed_at = null;
        break;
    }
    save(ctx, s);
  },
};
