import { D, floatRepr, loans } from "@cashu/domain";
import { addLoan, recordBalance, setLoan, setPaymentMatching } from "@cashu/store";
import { mcpLoanRows } from "@cashu/store/loans/queries";
import type { OpenVault } from "../../stores.js";
import { cashMoney } from "../budget/cashOutput.js";
import { richTable } from "../budget/richTable.js";
import {
  cliCommandKey,
  reportCliCommandFailure,
  reportCliProjectionUnavailable,
  runCliVaultCommand,
} from "../commandOutcome.js";
import {
  type LoanAssetDeps,
  localDay,
  selectedVault,
  stillSelected,
  usage,
} from "../nativeContext.js";
import { date, decimal, parse, positiveInt } from "../nativeInput.js";
import { N } from "../nativeStrings.js";
import type { CommandIo, PortedCommand } from "../tree.js";

function resolveLoanAccount(vault: OpenVault, reference: string): string | null {
  const read = vault.store.read.bind(vault.store);
  const byGid = read<{ gid: string }>(
    "SELECT gid FROM accounts WHERE gid = ? AND removed_at IS NULL AND type IN ('mortgage', 'loan')",
    reference,
  );
  if (byGid.length === 1) return byGid[0]?.gid ?? null;
  const byName = read<{ gid: string }>(
    "SELECT gid FROM accounts WHERE name = ? AND removed_at IS NULL AND type IN ('mortgage', 'loan') ORDER BY gid",
    reference,
  );
  return byName.length === 1 ? (byName[0]?.gid ?? null) : null;
}

function terms(args: readonly string[], io: CommandIo, deps: LoanAssetDeps, add: boolean) {
  const parsed = parse(
    args,
    add
      ? [
          "--principal",
          "--rate",
          "--account",
          "--years",
          "--months",
          "--start",
          "--origination",
          "--type",
          "--currency",
          "--payment-iban",
          "--payment-text",
        ]
      : ["--years", "--months", "--start", "--origination"],
  );
  const principalRaw = add ? parsed?.options.get("--principal") : parsed?.args[1];
  const rateRaw = add ? parsed?.options.get("--rate") : parsed?.args[2];
  const principal = decimal(principalRaw);
  const annualRate = decimal(rateRaw);
  const years = parsed?.options.has("--years") ? positiveInt(parsed.options.get("--years")) : 30;
  const months = parsed?.options.has("--months")
    ? positiveInt(parsed.options.get("--months"))
    : years === null
      ? null
      : years * 12;
  const start = parsed?.options.has("--start")
    ? date(parsed.options.get("--start"))
    : `${localDay(deps.now()).slice(0, 7)}-01`;
  const origination = parsed?.options.has("--origination")
    ? date(parsed.options.get("--origination"))
    : null;
  if (
    !parsed ||
    principal === null ||
    annualRate === null ||
    months === null ||
    months < 1 ||
    start === null ||
    (parsed.options.has("--origination") && origination === null) ||
    (!add && parsed.args.length !== 3)
  ) {
    usage(io, add ? io.t.tr(N.loanAddUsage) : io.t.tr(N.loanSetUsage));
    return null;
  }
  return {
    parsed,
    input: {
      principal,
      annualRate,
      termMonths: months,
      startDate: start,
      originationDate: origination,
    },
  };
}

async function add(
  args: readonly string[],
  io: CommandIo,
  root: { readonly profile?: string },
  deps: LoanAssetDeps,
): Promise<number> {
  const value = terms(args, io, deps, true);
  if (!value) return 2;
  const { parsed, input } = value;
  const account = parsed.options.get("--account");
  const name = parsed.args[0];
  const type = parsed.options.get("--type") ?? "loan";
  const currency = parsed.options.get("--currency");
  if (
    (name === undefined) === (account === undefined) ||
    parsed.args.length > 1 ||
    !["mortgage", "loan"].includes(type) ||
    (currency !== undefined && !/^[A-Z]{3}$/.test(currency))
  )
    return usage(io, io.t.tr(N.loanChoice));
  const vault = selectedVault(io, root, deps);
  if (!vault) return 2;
  const accountGid = account === undefined ? undefined : resolveLoanAccount(vault, account);
  if (account !== undefined && accountGid === null) return usage(io, io.t.tr(N.loanAccount));
  const key = cliCommandKey();
  if (io.signal.aborted) return 130;
  const proposed = {
    ...input,
    ...(name === undefined ? { account: accountGid } : { name }),
    type,
    ...(currency ? { currency } : {}),
    ...(parsed.options.has("--payment-iban")
      ? { paymentIban: parsed.options.get("--payment-iban") }
      : {}),
    ...(parsed.options.has("--payment-text")
      ? { paymentText: parsed.options.get("--payment-text") }
      : {}),
  };
  const result = await runCliVaultCommand(
    vault,
    addLoan,
    proposed,
    key,
    stillSelected(vault, io, root, deps),
  );
  if (result.kind !== "completed") return reportCliCommandFailure(io, result, key, addLoan.id);
  if (!stillSelected(vault, io, root, deps)())
    return reportCliProjectionUnavailable(io, key, addLoan.id);
  const read = vault.store.read.bind(vault.store);
  const row = read<{ gid: string; loanGid: string; name: string; currency: string }>(
    "SELECT a.gid, l.gid AS loanGid, a.name, a.currency FROM accounts a JOIN loans l ON l.account_id = a.id WHERE a.gid = ?",
    result.value.account,
  )[0];
  if (!row) {
    io.stderr(`${io.t.tr(N.loanSavedUncertain)(addLoan.id, key)}\n`);
    return 1;
  }
  io.stdout(
    `${io.t.tr(N.loanSaved)(row.loanGid, row.gid, cashMoney(D(input.principal), row.currency), floatRepr(Number(input.annualRate)))}\n`,
  );
  return 0;
}

async function setTerms(
  args: readonly string[],
  io: CommandIo,
  root: { readonly profile?: string },
  deps: LoanAssetDeps,
): Promise<number> {
  const value = terms(args, io, deps, false);
  if (!value) return 2;
  const vault = selectedVault(io, root, deps);
  if (!vault) return 2;
  const account = value.parsed.args[0] as string;
  const key = cliCommandKey();
  if (io.signal.aborted) return 130;
  const result = await runCliVaultCommand(
    vault,
    setLoan,
    { account, ...value.input },
    key,
    stillSelected(vault, io, root, deps),
  );
  if (result.kind !== "completed") return reportCliCommandFailure(io, result, key, setLoan.id);
  const months = value.input.termMonths;
  io.stdout(
    `${io.t.tr(N.loanTerms)(account, D(value.input.principal).quantize(0).format(",.0f"), value.input.annualRate, months, value.input.startDate)}\n`,
  );
  return 0;
}

async function payment(
  args: readonly string[],
  io: CommandIo,
  root: { readonly profile?: string },
  deps: LoanAssetDeps,
): Promise<number> {
  const parsed = parse(args, ["--iban", "--text"]);
  if (
    !parsed ||
    parsed.args.length !== 1 ||
    (!parsed.options.has("--iban") && !parsed.options.has("--text"))
  )
    return usage(io, io.t.tr(N.loanPaymentUsage));
  const vault = selectedVault(io, root, deps);
  if (!vault) return 2;
  const loan = mcpLoanRows(vault.store.read.bind(vault.store)).find(
    (row) => row.loan.id === parsed.args[0],
  );
  if (!loan) return usage(io, io.t.tr(N.loanMissing));
  const key = cliCommandKey();
  if (io.signal.aborted) return 130;
  const result = await runCliVaultCommand(
    vault,
    setPaymentMatching,
    {
      account: loan.account.gid,
      ...(parsed.options.has("--iban") ? { iban: parsed.options.get("--iban") } : {}),
      ...(parsed.options.has("--text") ? { text: parsed.options.get("--text") } : {}),
    },
    key,
    stillSelected(vault, io, root, deps),
  );
  if (result.kind !== "completed")
    return reportCliCommandFailure(io, result, key, setPaymentMatching.id);
  io.stdout(`${io.t.tr(N.loanPaymentSaved)(loan.loan.id)}\n`);
  return 0;
}

async function balance(
  args: readonly string[],
  io: CommandIo,
  root: { readonly profile?: string },
  deps: LoanAssetDeps,
): Promise<number> {
  const parsed = parse(args, ["--date"]);
  const amount = decimal(parsed?.args[1]);
  const onDate = parsed?.options.has("--date")
    ? date(parsed.options.get("--date"))
    : localDay(deps.now());
  if (!parsed || parsed.args.length !== 2 || amount === null || onDate === null)
    return usage(io, io.t.tr(N.loanBalanceUsage));
  const vault = selectedVault(io, root, deps);
  if (!vault) return 2;
  const loan = mcpLoanRows(vault.store.read.bind(vault.store)).find(
    (row) => row.loan.id === parsed.args[0],
  );
  if (!loan) return usage(io, io.t.tr(N.loanMissing));
  const key = cliCommandKey();
  if (io.signal.aborted) return 130;
  const result = await runCliVaultCommand(
    vault,
    recordBalance,
    { account: loan.account.gid, amount, date: onDate, source: "manual" },
    key,
    stillSelected(vault, io, root, deps),
  );
  if (result.kind !== "completed")
    return reportCliCommandFailure(io, result, key, recordBalance.id);
  io.stdout(
    `${io.t.tr(N.loanBalanceSaved)(loan.loan.id, D(amount).quantize(-2).format(",.2f"))}\n`,
  );
  return 0;
}

function list(
  args: readonly string[],
  io: CommandIo,
  root: { readonly profile?: string },
  deps: LoanAssetDeps,
): number {
  if (args.length) return usage(io, io.t.tr(N.loanListUsage));
  const vault = selectedVault(io, root, deps);
  if (!vault) return 2;
  const rows = mcpLoanRows(vault.store.read.bind(vault.store));
  if (!rows.length) {
    io.stdout(`${io.t.tr(N.noLoans)}\n`);
    return 0;
  }
  const today = localDay(deps.now());
  const table = richTable(
    io,
    io.t.tr(N.loanHeaders).map((header) => ({
      header,
    })),
    rows.map(({ loan, account, balances }) => {
      const valuation = loans.loanValuation(loan, balances);
      return [
        loan.id,
        account.name,
        account.type,
        `${loan.annualRate.format("f")}%`,
        loan.startDate,
        io.t.tr(N.monthCount)(loan.termMonths),
        cashMoney(valuation.at(today), account.currency),
        io.t.tr(N.balanceSource)(valuation.source(today)),
      ];
    }),
    io.t.tr(N.loansTitle),
  );
  if (table === null) return usage(io, io.t.tr(N.loanRender));
  io.stdout(table);
  for (const row of rows) io.stdout(`${io.t.tr(N.loanGid)(row.loan.id)}\n`);
  return 0;
}

export function loansCommands(deps: LoanAssetDeps): PortedCommand[] {
  return [
    { name: "set-loan", run: (args, io, root) => setTerms(args, io, root, deps) },
    {
      name: "loans",
      run: (args, io, root) => {
        const [subcommand, ...rest] = args;
        if (subcommand === "list") return Promise.resolve(list(rest, io, root, deps));
        if (subcommand === "add") return add(rest, io, root, deps);
        if (subcommand === "set-loan") return setTerms(rest, io, root, deps);
        if (subcommand === "set-payment") return payment(rest, io, root, deps);
        if (subcommand === "set-balance") return balance(rest, io, root, deps);
        return Promise.resolve(usage(io, io.t.tr(N.loansUsage)));
      },
    },
  ];
}
