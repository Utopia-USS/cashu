// Only the source's provably empty transfer operation is representable without procedural state.
import { budgetBook } from "@cashu/store/budget/queries";
import { mcpProfile } from "@cashu/store/core";
import { printConsole, supportsConsoleUnicode } from "../core/console.js";
import type { CommandIo } from "../tree.js";
import type { CategorizeDeps } from "./categorizeOllama.js";

const DELEGATE = { kind: "delegate" } as const;
export async function runEmptyTransfers(
  args: readonly string[],
  io: CommandIo,
  root: { readonly profile?: string },
  deps: CategorizeDeps,
): Promise<number | typeof DELEGATE> {
  let reset = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--reset") reset = true;
    else if (arg === "--no-reset") reset = false;
    else if (arg === "--max-days" || arg.startsWith("--max-days=")) {
      const value = arg === "--max-days" ? args[++i] : arg.slice("--max-days=".length);
      // Other integer spellings remain Typer's responsibility before any native output.
      if (
        value === undefined ||
        !/^[+-]?[0-9]+$/.test(value) ||
        !Number.isSafeInteger(Number(value))
      )
        return DELEGATE;
    } else if (!(arg === "--" && i === args.length - 1)) return DELEGATE;
  }
  const slug = root.profile || io.env.CASHU_PROFILE;
  if (!slug || !supportsConsoleUnicode(io)) return DELEGATE;
  const matches = [...deps.stores.vaults.values()].filter(
    (v) => mcpProfile(v.store.read.bind(v.store))?.slug === slug,
  );
  const vault = matches.length === 1 ? matches[0] : undefined;
  if (!vault) return DELEGATE;
  return vault.queue.run(() => {
    if (io.signal.aborted) return 130;
    if (
      deps.stores.vaults.get(vault.id) !== vault ||
      mcpProfile(vault.store.read.bind(vault.store))?.slug !== slug
    )
      return DELEGATE;
    if (budgetBook(vault.store.read.bind(vault.store)).transactions.length !== 0) return DELEGATE;
    if (reset) printConsole(io, "Cleared 0 previously-grouped transactions.");
    const text = "Matched 0 internal-transfer pair(s).";
    printConsole(io, text, { spans: [{ start: 0, end: text.length, style: { color: 32 } }] });
    return 0;
  });
}
