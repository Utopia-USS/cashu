import { D } from "@cashu/domain";
import { recordBalance, renameAccount, setAccountType } from "@cashu/store";
import { mcpProfile } from "@cashu/store/core";
import type { HostStores, OpenVault } from "../../stores.js";
import { cashMoney } from "../budget/cashOutput.js";
import { richTable } from "../budget/richTable.js";
import { cliCommandKey, reportCliCommandFailure, runCliVaultCommand } from "../commandOutcome.js";
import { date, decimal, parse } from "../nativeInput.js";
import type { CommandIo, PortedCommand } from "../tree.js";
import { C } from "./strings.js";

interface Deps {
  readonly stores: Pick<HostStores, "vaults">;
  readonly now: () => number;
}
type Root = { readonly profile?: string };
type Account = {
  readonly gid: string;
  readonly bank: string;
  readonly name: string;
  readonly iban: string | null;
  readonly type: string;
  readonly currency: string;
  readonly active: number;
};

function selected(io: CommandIo, root: Root, deps: Deps): OpenVault | null {
  const slug = root.profile || io.env.CASHU_PROFILE;
  if (!slug) {
    io.stderr(`${io.t.tr(C.selectProfile)}\n`);
    return null;
  }
  const matches = [...deps.stores.vaults.values()].filter(
    (v) => mcpProfile(v.store.read.bind(v.store))?.slug === slug,
  );
  if (matches.length !== 1) io.stderr(`${io.t.tr(C.missingProfile)}\n`);
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

function account(vault: OpenVault, gid: string): Account | undefined {
  return vault.store.read<Account>(
    "SELECT gid, bank, name, iban, type, currency, active FROM accounts WHERE gid = ? AND removed_at IS NULL",
    gid,
  )[0];
}

function current(vault: OpenVault, io: CommandIo, root: Root, deps: Deps): () => boolean {
  const slug = root.profile || io.env.CASHU_PROFILE;
  return () =>
    !io.signal.aborted &&
    deps.stores.vaults.get(vault.id) === vault &&
    mcpProfile(vault.store.read.bind(vault.store))?.slug === slug;
}

function usage(io: CommandIo, text: string): number {
  io.stderr(`${text}\n`);
  return 2;
}

function list(args: readonly string[], io: CommandIo, root: Root, deps: Deps): number {
  if (args.length) return usage(io, io.t.tr(C.accountsUsage));
  const vault = selected(io, root, deps);
  if (!vault) return 2;
  const rows = vault.store.read<Account>(
    "SELECT gid, bank, name, iban, type, currency, active FROM accounts WHERE removed_at IS NULL ORDER BY id",
  );
  const table = richTable(
    io,
    io.t.tr(C.accountHeaders).map((header) => ({ header })),
    rows.map((a) => [
      a.gid,
      a.bank,
      a.name,
      a.iban ?? "-",
      a.type,
      a.currency,
      io.t.tr(a.active ? C.yes : C.no),
    ]),
    io.t.tr(C.accountsTitle),
  );
  if (table === null) return usage(io, io.t.tr(C.accountRender));
  io.stdout(table);
  for (const row of rows) io.stdout(`${io.t.tr(C.accountGid)(row.gid)}\n`);
  return 0;
}

async function change(
  kind: "name" | "type" | "balance",
  args: readonly string[],
  io: CommandIo,
  root: Root,
  deps: Deps,
): Promise<number> {
  const parsed = parse(args, kind === "balance" ? ["--date"] : []);
  const gid = parsed?.args[0];
  if (!parsed || !gid || parsed.args.length !== 2 || (kind !== "balance" && parsed.options.size))
    return usage(
      io,
      kind === "balance" ? io.t.tr(C.balanceUsage) : io.t.tr(C.accountUsage)(`set-account-${kind}`),
    );
  const vault = selected(io, root, deps);
  if (!vault) return 2;
  const row = account(vault, gid);
  if (!row) return usage(io, io.t.tr(C.noAccount)(gid));
  const now = new Date(deps.now());
  const day = parsed.options.has("--date")
    ? date(parsed.options.get("--date"))
    : `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const amount = kind === "balance" ? decimal(parsed.args[1]) : null;
  if (kind === "balance" && (day === null || amount === null))
    return usage(io, io.t.tr(C.balanceUsage));
  if (kind === "name" && !parsed.args[1]?.trim()) return usage(io, io.t.tr(C.nameRequired));
  if (io.signal.aborted) return 130;
  const key = cliCommandKey();
  const guard = current(vault, io, root, deps);
  if (kind === "name") {
    const result = await runCliVaultCommand(
      vault,
      renameAccount,
      { account: row.gid, name: parsed.args[1] },
      key,
      guard,
    );
    if (result.kind !== "completed")
      return reportCliCommandFailure(io, result, key, renameAccount.id);
    io.stdout(`${io.t.tr(C.accountChanged)(gid)}\n`);
  } else if (kind === "type") {
    const result = await runCliVaultCommand(
      vault,
      setAccountType,
      { account: row.gid, type: parsed.args[1] },
      key,
      guard,
    );
    if (result.kind !== "completed")
      return reportCliCommandFailure(io, result, key, setAccountType.id);
    io.stdout(`${io.t.tr(C.accountChanged)(gid)}\n`);
  } else {
    const result = await runCliVaultCommand(
      vault,
      recordBalance,
      { account: row.gid, date: day, amount, source: "manual" },
      key,
      guard,
    );
    if (result.kind !== "completed")
      return reportCliCommandFailure(io, result, key, recordBalance.id);
    io.stdout(
      `${io.t.tr(C.accountBalanceChanged)(gid, cashMoney(D(amount as string), row.currency))}\n`,
    );
  }
  return 0;
}

export function accountCommands(deps: Deps): PortedCommand[] {
  return [
    { name: "accounts", run: async (args, io, root) => list(args, io, root, deps) },
    { name: "set-account-name", run: (args, io, root) => change("name", args, io, root, deps) },
    { name: "set-account-type", run: (args, io, root) => change("type", args, io, root, deps) },
    { name: "set-balance", run: (args, io, root) => change("balance", args, io, root, deps) },
  ];
}
