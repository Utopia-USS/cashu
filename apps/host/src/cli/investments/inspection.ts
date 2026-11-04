import { alerts } from "@cashu/domain/investments";
import { cleanSearchQuery, projectInstrumentSearch } from "@cashu/store/investments/services";
import { localDate } from "../budget/context.js";
import { richTable } from "../budget/richTable.js";
import { printConsole } from "../core/console.js";
import { S } from "../strings.js";
import type { CommandIo } from "../tree.js";
import { type InvestmentCliDeps, investmentVault } from "./context.js";

export const UNHANDLED = { kind: "unhandled" } as const;

export function alertKinds(args: readonly string[], io: CommandIo): number | typeof UNHANDLED {
  if (args.length) return UNHANDLED;
  for (const info of alerts.CATALOG.values()) {
    const params = info.params
      .map(
        (param) =>
          `${param.name}${param.required ? "" : "?"}${param.default === null ? "" : `=${param.default}`}`,
      )
      .join(", ");
    printConsole(io, `${info.kind} [${info.scopes.join("/")}] (${params}): ${info.doc}`, {
      highlight: false,
    });
  }
  return 0;
}

export async function localSearch(
  args: readonly string[],
  io: CommandIo,
  root: { readonly profile?: string },
  deps: InvestmentCliDeps,
): Promise<number | typeof UNHANDLED> {
  const local = args.includes("--local");
  if (args.length !== (local ? 2 : 1)) return UNHANDLED;
  const raw = args.find((arg) => arg !== "--local");
  if (!raw || raw.startsWith("-")) return UNHANDLED;
  let query: string;
  try {
    query = cleanSearchQuery(raw);
  } catch {
    return UNHANDLED;
  }
  const vault = investmentVault(io, root, deps);
  if (!vault) return UNHANDLED;
  const current = () =>
    !io.signal.aborted &&
    deps.stores.vaults.get(vault.id) === vault &&
    investmentVault(io, root, deps) === vault;
  if (!current()) return UNHANDLED;
  let answer:
    | {
        readonly hits: readonly import("@cashu/domain/investments").market.SearchHit[];
        readonly status: "ok" | "skipped" | "unavailable";
      }
    | undefined;
  if (!local) {
    const remote = deps.searchIo?.(vault);
    if (remote && remote.vault === vault.id && remote.isCurrent() && query.length >= 2) {
      try {
        answer = await remote.remoteHits(query, io.signal);
      } catch {
        if (!current()) return UNHANDLED;
        answer = { hits: [], status: "unavailable" };
      }
      if (!current() || !remote.isCurrent()) return UNHANDLED;
    } else {
      answer = { hits: [], status: query.length < 2 ? "skipped" : "unavailable" };
    }
  }
  let result: ReturnType<typeof projectInstrumentSearch>;
  try {
    result = projectInstrumentSearch(
      {
        read: vault.store.read.bind(vault.store),
        asOf: localDate(deps.now()),
      },
      query,
      {},
      answer,
    );
  } catch {
    return UNHANDLED;
  }
  if (result.remote_status === "unavailable")
    io.stderr(`${io.t.tr(S.investmentSearchUnavailable)}\n`);
  const hits = [...result.local, ...result.remote];
  if (!hits.length) {
    printConsole(io, `No instrument matches "${result.query}".`);
    return 0;
  }
  const rows = hits.map((hit) => [
    hit.symbol,
    hit.yahoo_symbol ?? "-",
    hit.name,
    hit.exchange ?? hit.mic ?? "-",
    hit.asset_class,
    hit.state,
  ]);
  const table = richTable(
    io,
    ["symbol", "yahoo", "name", "exchange", "type", "state"].map((header) => ({ header })),
    rows,
    `Search "${result.query}"`,
  );
  if (table === null) return UNHANDLED;
  io.stdout(table);
  return 0;
}
