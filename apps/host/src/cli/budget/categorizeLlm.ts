// One local merchant-classifier run: snapshot, network outside the write queue, guarded append.
import { budget } from "@cashu/domain";
import { cacheLlmRules, runCommand } from "@cashu/store";
import { budgetBook } from "@cashu/store/budget/queries";
import { mcpProfile } from "@cashu/store/core";
import type { OpenVault } from "../../stores.js";
import { printConsole } from "../core/console.js";
import type { CommandIo } from "../tree.js";
import { S } from "./categorize.strings.js";
import {
  type CategorizeDeps,
  ClassifierAuthorityLost,
  OllamaClassifier,
  ollamaOptions,
} from "./categorizeOllama.js";
import { importTextSupported } from "./importInput.js";

const DELEGATE = { kind: "delegate" } as const;
export async function runMerchantClassification(
  vault: OpenVault,
  slug: string,
  io: CommandIo,
  deps: CategorizeDeps,
): Promise<number | typeof DELEGATE> {
  const snapshot = await vault.queue.run(() => {
    if (io.signal.aborted) return null;
    if (
      deps.stores.vaults.get(vault.id) !== vault ||
      mcpProfile(vault.store.read.bind(vault.store))?.slug !== slug
    )
      return null;
    const book = budgetBook(vault.store.read.bind(vault.store));
    return {
      total: book.transactions.length,
      merchants: budget.unknownMerchants(
        book.transactions.map((t) => ({
          amount: t.amount,
          merchantKey: budget.merchantKey(t.counterpartyName, t.reference, t.description),
          source: t.categorySource,
        })),
      ),
    };
  });
  if (snapshot === null) return io.signal.aborted ? 130 : DELEGATE;
  if (!snapshot.merchants.length) {
    const text = `Categorized ${snapshot.total} transactions.`;
    printConsole(io, text, { spans: [{ start: 0, end: text.length, style: { color: 32 } }] });
    printConsole(io, "  LLM: +0 rules (0 unknown expense merchants)");
    return 0;
  }
  const provider = deps.classifier;
  const options = ollamaOptions(io);
  if (
    !provider ||
    !options ||
    !provider.isHolder(vault.id) ||
    !importTextSupported(options.model) ||
    (io.env.CASHU_CATEGORIZE_LLM_BACKEND || "ollama").toLowerCase() !== "ollama"
  )
    return DELEGATE;
  let answers: Awaited<ReturnType<OllamaClassifier["classifyMerchants"]>>;
  try {
    answers = await new OllamaClassifier(provider, vault.id, io, options).classifyMerchants(
      snapshot.merchants,
      budget.AUTO_CATEGORY_KEYS,
    );
  } catch (error) {
    if (!(error instanceof ClassifierAuthorityLost)) throw error;
    if (io.signal.aborted) return 130;
    io.stderr(`${io.t.tr(S.authorityChanged)}\n`);
    return 1;
  }
  return vault.queue.run(() => {
    if (io.signal.aborted) return 130;
    if (
      deps.stores.vaults.get(vault.id) !== vault ||
      mcpProfile(vault.store.read.bind(vault.store))?.slug !== slug ||
      !provider.isHolder(vault.id)
    ) {
      io.stderr(`${io.t.tr(S.authorityChanged)}\n`);
      return 1;
    }
    let cached = 0;
    if (answers.ok) {
      const result = runCommand(
        vault.store,
        vault.writer,
        cacheLlmRules,
        {
          items: [...answers.answers].map(([merchantKey, answer]) => ({
            merchantKey,
            category: answer.category,
          })),
        },
        vault.env,
      );
      if (!result.ok) throw new Error("native merchant classifier refused validated answers");
      cached = result.value.cached;
    }
    const text = `Categorized ${snapshot.total} transactions.`;
    printConsole(io, text, { spans: [{ start: 0, end: text.length, style: { color: 32 } }] });
    if (answers.ok)
      printConsole(
        io,
        `  LLM: +${cached} rules (${snapshot.merchants.length} unknown expense merchants)`,
      );
    else {
      const error = `LLM skipped: Ollama returned nothing (is it running? model '${options.model}' pulled?)`;
      printConsole(io, error, { spans: [{ start: 0, end: error.length, style: { color: 33 } }] });
    }
    return 0;
  });
}
