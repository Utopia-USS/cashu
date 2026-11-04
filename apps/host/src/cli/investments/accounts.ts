import { views } from "@cashu/domain/investments";
import { investmentsCommands } from "@cashu/store";
import { enabledModuleIds, mcpProfile } from "@cashu/store/core";
import { brokerageAccountFacts } from "@cashu/store/investments/views";
import { richTable } from "../budget/richTable.js";
import {
  cliCommandKey,
  reportCliCommandFailure,
  reportCliProjectionUnavailable,
  runCliVaultCommand,
} from "../commandOutcome.js";
import { printConsole } from "../core/console.js";
import type { CommandIo } from "../tree.js";
import { type InvestmentCliDeps, investmentVault } from "./context.js";
import { DELEGATE } from "./inspection.js";
import { investmentCliText as M } from "./strings.js";

type AddInput = { name: string; broker: string; wrapper: string; currency: string };

function parseAdd(args: readonly string[]): AddInput | null {
  let name: string | undefined;
  let broker: string | undefined;
  let wrapper = "regular";
  let currency = "PLN";
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) return null;
    const equal = arg.indexOf("=");
    const flag = equal < 0 ? arg : arg.slice(0, equal);
    if (["--broker", "--wrapper", "--currency"].includes(flag)) {
      if (seen.has(flag)) return null;
      seen.add(flag);
      const value = equal < 0 ? args[++i] : arg.slice(equal + 1);
      if (!value || value.startsWith("--")) return null;
      if (flag === "--broker") broker = value;
      if (flag === "--wrapper") wrapper = value;
      if (flag === "--currency") currency = value;
    } else if (name === undefined && !arg.startsWith("-")) name = arg;
    else return null;
  }
  return name && broker ? { name, broker, wrapper, currency } : null;
}

export async function accounts(
  args: readonly string[],
  io: CommandIo,
  root: { readonly profile?: string },
  deps: InvestmentCliDeps,
): Promise<number | typeof DELEGATE> {
  const [action, ...rest] = args;
  const vault = investmentVault(io, root, deps);
  if (!vault) return DELEGATE;
  const read = vault.store.read.bind(vault.store);
  if (action === "list" && rest.length === 0) {
    const rows = views.accountsView(brokerageAccountFacts(read, io.t.language), null);
    if (!rows.length) {
      printConsole(io, io.t.tr(M.noAccounts));
      return 0;
    }
    const table = richTable(
      io,
      [
        M.columns.id,
        M.columns.name,
        M.columns.broker,
        M.columns.wrapper,
        M.columns.currency,
        M.columns.importer,
        M.columns.snapshot,
        M.columns.lastImport,
      ].map((label) => ({ header: io.t.tr(label) })),
      rows.map((r) => [
        r.id,
        r.name,
        r.broker_name,
        r.wrapper,
        r.currency,
        r.importer ?? "-",
        r.snapshot_date ?? "-",
        r.last_import?.at?.slice(0, 10) ?? "-",
      ]),
      io.t.tr(M.accountsTitle),
    );
    if (table === null) return DELEGATE;
    io.stdout(table);
    // A 26-character native GID is otherwise ellipsized in an 80-column table.
    for (const row of rows) printConsole(io, `  ${row.id}  ${row.name}`, { highlight: false });
    return 0;
  }
  if (action !== "add") return DELEGATE;
  const input = parseAdd(rest);
  if (!input) return DELEGATE;
  if (io.signal.aborted) return 130;
  // The native command performs the same broker, wrapper, currency and duplicate validation.
  const key = cliCommandKey();
  const slug = root.profile || io.env.CASHU_PROFILE;
  const current = () =>
    !io.signal.aborted &&
    deps.stores.vaults.get(vault.id) === vault &&
    mcpProfile(read)?.slug === slug &&
    enabledModuleIds(read).has("investments");
  if (!current()) return DELEGATE;
  const result = await runCliVaultCommand(
    vault,
    investmentsCommands.addBrokerageAccount,
    input,
    key,
    current,
  );
  if (result.kind === "refused" && result.reason === "cli_context_changed") return DELEGATE;
  if (result.kind !== "completed")
    return reportCliCommandFailure(io, result, key, investmentsCommands.addBrokerageAccount.id);
  const account = result.value.account;
  if (!current() || !brokerageAccountFacts(read, io.t.language).some((row) => row.id === account))
    return reportCliProjectionUnavailable(io, key, investmentsCommands.addBrokerageAccount.id);
  printConsole(
    io,
    `${io.t.tr(M.accountAdded)} '${input.name.trim()}' (id ${account}, ${input.broker}, ${input.wrapper}).`,
  );
  return 0;
}
