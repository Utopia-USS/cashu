import { alerts } from "@cashu/domain/investments";
import { mcpProfile } from "@cashu/store/core";
import { projectInstrumentSearch } from "@cashu/store/investments/services";
import { localDate } from "../budget/context.js";
import { richTable } from "../budget/richTable.js";
import { printConsole, supportsConsoleUnicode } from "../core/console.js";
import type { CommandIo } from "../tree.js";
import type { InvestmentCliDeps } from "./context.js";

export const DELEGATE = { kind: "delegate" } as const;

export function alertKinds(args: readonly string[], io: CommandIo): number | typeof DELEGATE {
  if (args.length || !supportsConsoleUnicode(io)) return DELEGATE;
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

export function localSearch(
  args: readonly string[],
  io: CommandIo,
  root: { readonly profile?: string },
  deps: InvestmentCliDeps,
): number | typeof DELEGATE {
  if (args.length !== 2 || !args.includes("--local") || !supportsConsoleUnicode(io))
    return DELEGATE;
  const query = args.find((arg) => arg !== "--local");
  if (!query || query.startsWith("-")) return DELEGATE;
  const slug = root.profile || io.env.CASHU_PROFILE;
  if (!slug) return DELEGATE;
  const matches = [...deps.stores.vaults.values()].filter(
    (vault) => mcpProfile(vault.store.read.bind(vault.store))?.slug === slug,
  );
  if (matches.length !== 1) return DELEGATE;
  const vault = matches[0];
  if (!vault) return DELEGATE;
  let result: ReturnType<typeof projectInstrumentSearch>;
  try {
    result = projectInstrumentSearch(
      {
        read: vault.store.read.bind(vault.store),
        asOf: localDate(deps.now()),
      },
      query,
    );
  } catch {
    return DELEGATE;
  }
  if (!result.local.length) {
    printConsole(io, `No instrument matches "${result.query}".`);
    return 0;
  }
  const rows = result.local.map((hit) => [
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
  if (table === null) return DELEGATE;
  io.stdout(table);
  return 0;
}
