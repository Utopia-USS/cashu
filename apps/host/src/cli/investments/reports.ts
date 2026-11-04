import { formatFloat } from "@cashu/domain";
import { asAccountId, asProfileId, performance as perf } from "@cashu/domain/investments";
import { readPositions } from "@cashu/store/investments/views";
import { investmentEntityIdSchema } from "@cashu/store/investments/screen-sources";
import { richTable } from "../budget/richTable.js";
import { printConsole } from "../core/console.js";
import type { CommandIo } from "../tree.js";
import { S } from "../strings.js";
import { type InvestmentCliDeps, investmentContext, performanceStrategy } from "./context.js";
import { UNHANDLED } from "./inspection.js";

const num = (value: number | null | undefined, digits = 2): string =>
  value == null ? "-" : formatFloat(value, `,.${digits}f`).replaceAll(",", " ");
const pct = (value: number | null | undefined, digits = 1): string =>
  value == null ? "-" : `${formatFloat(value * 100, `.${digits}f`)}%`;
const decimal = (value: { toFloat(): number } | null | undefined, digits = 2): string =>
  num(value?.toFloat(), digits);
const validAccount = (value: string): boolean => investmentEntityIdSchema.safeParse(value).success;

function accountOption(args: readonly string[]): string | null | undefined {
  if (args.length === 0) return null;
  if (args.length === 2 && (args[0] === "--account" || args[0] === "-a"))
    return validAccount(args[1] ?? "") ? args[1] : undefined;
  if (args.length === 1) {
    const value = args[0]?.startsWith("--account=")
      ? args[0].slice("--account=".length)
      : args[0]?.startsWith("-a")
        ? args[0].slice(2)
        : "";
    return validAccount(value ?? "") ? value : undefined;
  }
  return undefined;
}

export function positions(
  args: readonly string[],
  io: CommandIo,
  root: { readonly profile?: string },
  deps: InvestmentCliDeps,
): number | typeof UNHANDLED {
  const account = accountOption(args);
  if (account === undefined) {
    if (args.some((arg) => arg === "--account" || arg === "-a" || arg.startsWith("--account="))) {
      io.stderr(`${io.t.tr(S.investmentAccountGid)}\n`);
      return 2;
    }
    return UNHANDLED;
  }
  const context = investmentContext(io, root, deps);
  if (!context) return UNHANDLED;
  const read = context.vault.store.read.bind(context.vault.store);
  const result = readPositions(read, {
    ...context.market,
    vault: asProfileId(context.vault.id),
    asOf: context.asOf,
    clock: { today: context.asOf, now: context.now, timeZone: context.timeZone },
    strategy: context.strategy,
    lang: io.t.language,
    forOwner: true,
    ...(account === null ? {} : { accounts: [asAccountId(account)] }),
  });
  if (!result.ok) {
    if (result.reason === "unknown_account") {
      io.stderr(`${io.t.tr(S.investmentAccountUnknown)}\n`);
      return 2;
    }
    return UNHANDLED;
  }
  const data = result.value;
  if (!data.positions.length && !data.cash.length) {
    printConsole(io, "No positions yet. Import a file: cashu invest import FILE --account ID");
    return 0;
  }
  const base = data.base_currency;
  const rows = [
    ...data.positions.map((row) => [
      row.instrument.label,
      row.instrument.asset_class,
      decimal(row.quantity, 4),
      `${decimal(row.price, 4)} ${row.price_currency ?? ""}`.trim(),
      `${row.price_date ?? "-"}${row.is_stale ? " (stale)" : ""}`,
      decimal(row.value),
      pct(row.weight),
      pct(row.unrealized_pct),
    ]),
    ...data.cash.map((cash) => [
      `cash ${cash.account_name ?? ""}`.trim(),
      "cash",
      decimal(cash.amount),
      cash.currency,
      "",
      decimal(cash.amount_base),
      "",
      "",
    ]),
    ["total", "", "", "", "", decimal(data.total), "", ""],
  ];
  const table = richTable(
    io,
    ["instrument", "class", "qty", "price", "date", `value ${base}`, "weight", "result"].map(
      (header) => ({ header }),
    ),
    rows,
    `Positions as of ${data.as_of} (${base})`,
    {
      boldCells: [
        { row: rows.length - 1, column: 0 },
        { row: rows.length - 1, column: 5 },
      ],
    },
  );
  if (table === null) return UNHANDLED;
  io.stdout(table);
  return 0;
}

interface PerformanceArgs {
  readonly range: string;
  readonly attribution: boolean;
  readonly account: string | null;
}
function parsePerformance(args: readonly string[]): PerformanceArgs | null {
  let range = "1y";
  let attribution = false;
  let seenRange = false;
  let account: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--attribution" && !attribution) attribution = true;
    else if ((arg === "--account" || arg === "-a") && account === null && args[i + 1]) {
      account = args[++i] as string;
    } else if (arg?.startsWith("--account=") && account === null) {
      account = arg.slice("--account=".length);
    } else if (arg === "--range" && !seenRange && args[i + 1]) {
      range = args[++i] as string;
      seenRange = true;
    } else if (arg?.startsWith("--range=") && !seenRange) {
      range = arg.slice(8);
      seenRange = true;
    } else return null;
  }
  return perf.isRangeKey(range) && (account === null || validAccount(account))
    ? { range, attribution, account }
    : null;
}

export function performance(
  args: readonly string[],
  io: CommandIo,
  root: { readonly profile?: string },
  deps: InvestmentCliDeps,
): number | typeof UNHANDLED {
  const parsed = parsePerformance(args);
  if (!parsed) {
    if (args.some((arg) => arg === "--account" || arg === "-a" || arg.startsWith("--account="))) {
      io.stderr(`${io.t.tr(S.investmentAccountGid)}\n`);
      return 2;
    }
    return UNHANDLED;
  }
  const context = investmentContext(io, root, deps);
  if (!context) return UNHANDLED;
  const request = {
    ...context.market,
    asOf: context.asOf,
    strategy: performanceStrategy(context),
    range: parsed.range,
    ...(parsed.account === null ? {} : { accounts: [parsed.account] }),
  };
  const view = deps.performance.performanceView(context.vault.store, request);
  const attribution = parsed.attribution
    ? deps.performance.attributionView(context.vault.store, request)
    : null;
  if (!view.ok || (attribution && !attribution.ok)) {
    if (
      (!view.ok && view.reason === "unknown_account") ||
      (attribution && !attribution.ok && attribution.reason === "unknown_account")
    ) {
      io.stderr(`${io.t.tr(S.investmentAccountUnknown)}\n`);
      return 2;
    }
    return UNHANDLED;
  }
  const data = view.value;
  const summary = data.summary;
  if (summary === null) {
    printConsole(io, "No investments history yet.");
    return 0;
  }
  const benchmark = data.benchmark;
  const sim = benchmark.simulation;
  const rows = [
    ["value", num(summary.end_value), num(sim?.end_value)],
    ["net contributions", num(summary.net_contributions), ""],
    ["P/L", num(summary.pnl), num(sim?.pnl)],
    ["TWR", pct(summary.twr, 2), pct(benchmark.twr, 2)],
    ["TWR p.a.", pct(summary.twr_annualized, 2), pct(benchmark.twr_annualized, 2)],
    ["XIRR", pct(summary.xirr, 2), pct(sim?.xirr, 2)],
    ["money-weighted", pct(summary.mwr, 2), pct(sim?.mwr, 2)],
    ["max drawdown", pct(summary.max_drawdown?.depth, 2), pct(benchmark.max_drawdown?.depth, 2)],
  ];
  const table = richTable(
    io,
    [
      { header: "" },
      { header: "portfolio", justify: "right" },
      { header: "benchmark", justify: "right" },
    ],
    rows,
  );
  if (table === null) return UNHANDLED;
  let attrTable: string | null = null;
  let attrLine: string | null = null;
  const concentration = attribution?.ok ? attribution.value.concentration : null;
  if (attribution?.ok) {
    attrTable = richTable(
      io,
      [
        { header: "instrument" },
        { header: "bucket" },
        { header: "P/L", justify: "right" },
        { header: "share", justify: "right" },
      ],
      attribution.value.instruments.map((row) => [
        row.label,
        row.bucket,
        num(row.pnl),
        pct(row.share_of_pnl, 2),
      ]),
    );
    if (attrTable === null || concentration === null) return UNHANDLED;
    const top2 = concentration.top.find((entry) => entry.n === 2)?.share ?? null;
    attrLine = `top 2 share of P/L: ${pct(top2, 2)}; P/L without them: ${num(concentration.pnl_without_top2)} (${pct(concentration.pnl_without_top2_pct_of_contributions, 2)} of contributions); benchmark: ${num(concentration.benchmark_pnl)} (${pct(concentration.benchmark_pnl_pct_of_contributions, 2)})`;
  }
  printConsole(io, `${data.range}: ${data.start} .. ${data.end} (${data.base_currency})`);
  io.stdout(table);
  printConsole(
    io,
    benchmark.status === "ok"
      ? `benchmark: ${benchmark.id} via ${benchmark.proxy}`
      : `benchmark: ${benchmark.status} - ${benchmark.message}`,
  );
  for (const window of data.rolling) {
    if (!window.windows) continue;
    printConsole(
      io,
      `rolling ${window.months}m: latest excess ${pct(window.latest_excess, 2)}, outperformed in ${pct(window.share_outperforming, 2)} of ${window.windows} window(s)`,
    );
  }
  for (const note of data.data_quality?.notes ?? [])
    printConsole(io, `! ${note.message}`, {
      spans: [{ start: 0, end: 1, style: { color: 33 } }],
    });
  if (attrTable !== null && attrLine !== null) {
    io.stdout(attrTable);
    printConsole(io, attrLine);
  }
  return 0;
}
