// Deterministic categories are already kept live by budget.categories; owner pins append rules.
import { budget, normalizeText } from "@cashu/domain";
import { setMerchantCategory } from "@cashu/store";
import { budgetBook } from "@cashu/store/budget/queries";
import { enabledModuleIds, mcpProfile } from "@cashu/store/core";
import {
  cliCommandKey,
  reportCliCommandFailure,
  reportCliProjectionUnavailable,
  runCliVaultCommand,
} from "../commandOutcome.js";
import { printConsole, supportsConsoleUnicode } from "../core/console.js";
import type { CommandIo, PortedCommand } from "../tree.js";
import { S } from "./categorize.strings.js";
import { runMerchantClassification } from "./categorizeLlm.js";
import type { CategorizeDeps } from "./categorizeOllama.js";
import { runReclassifyCommand } from "./categorizeReclassify.js";
import { runEmptyTransfers } from "./categorizeTransfers.js";
import { importTextSupported } from "./importInput.js";

export type { CategorizeDeps } from "./categorizeOllama.js";

const UNHANDLED = { kind: "unhandled" } as const;
export async function runCategorizeCommand(
  name: "categorize" | "set-category",
  args: readonly string[],
  io: CommandIo,
  root: { readonly profile?: string },
  deps: CategorizeDeps,
): Promise<number | typeof UNHANDLED> {
  const positional = args[0] === "--" ? args.slice(1) : args;
  const llm = name === "categorize" && args.includes("--llm");
  if (name === "categorize") {
    let ended = false;
    for (const arg of args) {
      if (!ended && arg === "--") ended = true;
      else if (ended || arg !== "--llm") return UNHANDLED;
    }
  } else if (positional.length !== 2) return UNHANDLED;
  if (name === "set-category" && args[0] !== "--" && positional.some((a) => a.startsWith("-")))
    return UNHANDLED;
  const slug = root.profile || io.env.CASHU_PROFILE;
  if (!slug || !supportsConsoleUnicode(io)) return UNHANDLED;
  const matches = [...deps.stores.vaults.values()].filter(
    (v) => mcpProfile(v.store.read.bind(v.store))?.slug === slug,
  );
  const vault = matches.length === 1 ? matches[0] : undefined;
  if (!vault) return UNHANDLED;
  const isCurrent = () => {
    const read = vault.store.read.bind(vault.store);
    return (
      !io.signal.aborted &&
      deps.stores.vaults.get(vault.id) === vault &&
      mcpProfile(read)?.slug === slug &&
      enabledModuleIds(read).has("budget")
    );
  };
  if (!isCurrent()) return io.signal.aborted ? 130 : UNHANDLED;
  if (name === "categorize" && llm) return runMerchantClassification(vault, slug, io, deps);
  const merchant = name === "set-category" ? normalizeText(positional[0] ?? "") : "";
  const category = positional[1] ?? "";
  if (
    name === "set-category" &&
    (!merchant || !budget.CATEGORY_KEYS.includes(category) || !importTextSupported(merchant))
  )
    return UNHANDLED;
  const key = cliCommandKey();
  const book = budgetBook(vault.store.read.bind(vault.store));
  if (name === "categorize") {
    // Python total is len(all profile rows), not a modified-row count. Native derivation already
    // preserves manual/cash/LLM claims and recomputes undecided rows as their facts change.
    const text = io.t.tr(S.categorized)(book.transactions.length);
    printConsole(io, text, { spans: [{ start: 0, end: text.length, style: { color: 32 } }] });
    return 0;
  }
  const result = await runCliVaultCommand(
    vault,
    setMerchantCategory,
    {
      merchantKey: merchant,
      category,
    },
    key,
    isCurrent,
  );
  if (result.kind !== "completed")
    return reportCliCommandFailure(io, result, key, setMerchantCategory.id);
  if (!isCurrent())
    return io.signal.aborted
      ? 130
      : reportCliProjectionUnavailable(io, key, setMerchantCategory.id);
  const label = `${merchant} → ${category}`;
  printConsole(io, io.t.tr(S.categoryPinned)(merchant, category, result.value.updated), {
    spans: [{ start: 0, end: label.length, style: { color: 32 } }],
  });
  return 0;
}
export function categorizeCommands(deps: CategorizeDeps): PortedCommand[] {
  return [
    ...(["categorize", "set-category"] as const).map((name) => ({
      name,
      run: (args: readonly string[], io: CommandIo, root: { readonly profile?: string }) =>
        runCategorizeCommand(name, args, io, root, deps),
    })),
    { name: "reclassify", run: (args, io, root) => runReclassifyCommand(args, io, root, deps) },
    { name: "match-transfers", run: (args, io, root) => runEmptyTransfers(args, io, root, deps) },
  ];
}
