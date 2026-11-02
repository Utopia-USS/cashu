// Deterministic categories are already kept live by budget.categories; owner pins append rules.
import { budget, normalizeText } from "@cashu/domain";
import { runCommand, setMerchantCategory } from "@cashu/store";
import { budgetBook } from "@cashu/store/budget/queries";
import { mcpProfile } from "@cashu/store/core";
import { printConsole, supportsConsoleUnicode } from "../core/console.js";
import type { CommandIo, PortedCommand } from "../tree.js";
import { runMerchantClassification } from "./categorizeLlm.js";
import type { CategorizeDeps } from "./categorizeOllama.js";
import { runReclassifyCommand } from "./categorizeReclassify.js";
import { runEmptyTransfers } from "./categorizeTransfers.js";
import { importTextSupported } from "./importInput.js";

export type { CategorizeDeps } from "./categorizeOllama.js";

const DELEGATE = { kind: "delegate" } as const;
export async function runCategorizeCommand(
  name: "categorize" | "set-category",
  args: readonly string[],
  io: CommandIo,
  root: { readonly profile?: string },
  deps: CategorizeDeps,
): Promise<number | typeof DELEGATE> {
  const positional = args[0] === "--" ? args.slice(1) : args;
  const llm = name === "categorize" && args.includes("--llm");
  if (name === "categorize") {
    let ended = false;
    for (const arg of args) {
      if (!ended && arg === "--") ended = true;
      else if (ended || arg !== "--llm") return DELEGATE;
    }
  } else if (positional.length !== 2) return DELEGATE;
  if (name === "set-category" && args[0] !== "--" && positional.some((a) => a.startsWith("-")))
    return DELEGATE;
  const slug = root.profile || io.env.CASHU_PROFILE;
  if (!slug || !supportsConsoleUnicode(io)) return DELEGATE;
  const matches = [...deps.stores.vaults.values()].filter(
    (v) => mcpProfile(v.store.read.bind(v.store))?.slug === slug,
  );
  const vault = matches.length === 1 ? matches[0] : undefined;
  if (!vault) return DELEGATE;
  if (name === "categorize" && llm) return runMerchantClassification(vault, slug, io, deps);
  const merchant = name === "set-category" ? normalizeText(positional[0] ?? "") : "";
  const category = positional[1] ?? "";
  if (
    name === "set-category" &&
    (!merchant || !budget.CATEGORY_KEYS.includes(category) || !importTextSupported(merchant))
  )
    return DELEGATE;
  return vault.queue.run(() => {
    if (io.signal.aborted) return 130;
    if (
      deps.stores.vaults.get(vault.id) !== vault ||
      mcpProfile(vault.store.read.bind(vault.store))?.slug !== slug
    )
      return DELEGATE;
    const book = budgetBook(vault.store.read.bind(vault.store));
    if (name === "categorize") {
      // Python total is len(all profile rows), not a modified-row count. Native derivation already
      // preserves manual/cash/LLM claims and recomputes undecided rows as their facts change.
      const text = `Categorized ${book.transactions.length} transactions.`;
      printConsole(io, text, { spans: [{ start: 0, end: text.length, style: { color: 32 } }] });
      return 0;
    }
    const rows = book.transactions.filter(
      (t) => budget.merchantKey(t.counterpartyName, t.reference, t.description) === merchant,
    );
    // Python's procedural pin skips an existing withdrawal/transfer even if an ordinary merchant
    // rule would override it. The native rule contract remains D-24.1; do not manufacture row claims.
    if (
      category === "cash_withdrawal" ||
      rows.some(
        (t) =>
          ["transfer", "cash_withdrawal"].includes(t.category ?? "") &&
          !t.isInternalTransfer &&
          !["manual_txn", "cash_leg", "transfer"].includes(t.categorySource ?? ""),
      )
    )
      return DELEGATE;
    const count = rows.filter(
      (t) =>
        !t.isInternalTransfer &&
        !["manual_txn", "cash_leg", "transfer"].includes(t.categorySource ?? "") &&
        !["transfer", "cash_withdrawal"].includes(t.category ?? ""),
    ).length;
    const result = runCommand(
      vault.store,
      vault.writer,
      setMerchantCategory,
      {
        merchantKey: merchant,
        category,
      },
      vault.env,
    );
    if (!result.ok) throw new Error("native category pin refused validated input");
    const text = `${merchant} → ${category}`;
    printConsole(io, `${text} (${count} transactions)`, {
      spans: [{ start: 0, end: text.length, style: { color: 32 } }],
    });
    return 0;
  });
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
