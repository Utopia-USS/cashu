// Full-context classification is local-only, explicitly authorized, and appended as one batch.
import { addDays, budget, type IsoDate, pyStrip, unicodeDecimal } from "@cashu/domain";
import { runCommand, setLlmCategories } from "@cashu/store";
import { budgetBook, budgetEngineContext } from "@cashu/store/budget/queries";
import { mcpProfile } from "@cashu/store/core";
import { vaultPaymentPatterns } from "@cashu/store/overview";
import type { OpenVault } from "../../stores.js";
import { printConsole, supportsConsoleUnicode } from "../core/console.js";
import type { CommandIo } from "../tree.js";
import { S } from "./categorize.strings.js";
import {
  type CategorizeDeps,
  ClassifierAuthorityLost,
  OllamaClassifier,
  ollamaOptions,
} from "./categorizeOllama.js";
import { importTextSupported } from "./importInput.js";
import { richTable } from "./richTable.js";

const DELEGATE = { kind: "delegate" } as const;
interface Options {
  readonly model?: string;
  readonly batchSize: number;
  readonly limit?: number;
  readonly recentDays?: number;
  readonly recentModel: string;
  readonly oldModel: string;
}
function integer(raw: string): number | undefined {
  const text = pyStrip(raw).replace(/\p{Nd}/gu, (c) =>
    String(unicodeDecimal(c.codePointAt(0) ?? 0)),
  );
  if (!/^[+-]?[0-9](?:_?[0-9])*$/.test(text)) return undefined;
  const value = Number(text.replaceAll("_", ""));
  return Number.isSafeInteger(value) ? value : undefined;
}
function options(args: readonly string[]): Options | undefined {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--" && i === args.length - 1) break;
    const at = arg.indexOf("="),
      key = at < 0 ? arg : arg.slice(0, at);
    if (
      ![
        "--model",
        "--batch-size",
        "--limit",
        "--recent-days",
        "--recent-model",
        "--old-model",
      ].includes(key)
    )
      return undefined;
    const value = at < 0 ? args[++i] : arg.slice(at + 1);
    if (value === undefined || (at < 0 && value.startsWith("--"))) return undefined;
    values.set(key, value);
  }
  const batchSize = integer(values.get("--batch-size") ?? "25");
  const limit = values.has("--limit") ? integer(values.get("--limit") as string) : undefined;
  const recentDays = values.has("--recent-days")
    ? integer(values.get("--recent-days") as string)
    : undefined;
  if (
    batchSize === undefined ||
    batchSize < 1 ||
    (values.has("--limit") && (limit === undefined || limit < 0)) ||
    (values.has("--recent-days") && recentDays === undefined)
  )
    return undefined;
  return {
    batchSize,
    ...(limit === undefined ? {} : { limit }),
    ...(recentDays === undefined ? {} : { recentDays }),
    ...(values.has("--model") ? { model: values.get("--model") as string } : {}),
    recentModel: values.get("--recent-model") ?? "qwen2.5:7b",
    oldModel: values.get("--old-model") ?? "qwen2.5:3b",
  };
}
function snapshot(vault: OpenVault) {
  const read = vault.store.read.bind(vault.store),
    book = budgetBook(read);
  const cash = new Set(
    book.accounts.filter((a) => a.type === budget.CASH_ACCOUNT_TYPE).map((a) => a.id),
  );
  const rows: budget.ReclassifyRow[] = book.transactions.map((t) => ({
    ...t,
    onCashAccount: cash.has(t.account),
    source: t.categorySource,
  }));
  const ctx = budgetEngineContext(read, vaultPaymentPatterns(read));
  const stamp = JSON.stringify({
    rows: rows.map((r) => ({ ...r, amount: r.amount.format("f") })),
    own: [...ctx.ownIbans],
    rules: [...ctx.rules],
    patterns: ctx.patterns,
  });
  return { rows, ctx, stamp };
}
export async function runReclassifyCommand(
  args: readonly string[],
  io: CommandIo,
  root: { readonly profile?: string },
  deps: CategorizeDeps,
): Promise<number | typeof DELEGATE> {
  const input = options(args),
    slug = root.profile || io.env.CASHU_PROFILE,
    provider = deps.classifier;
  if (!input || !slug || !supportsConsoleUnicode(io)) return DELEGATE;
  const matches = [...deps.stores.vaults.values()].filter(
    (v) => mcpProfile(v.store.read.bind(v.store))?.slug === slug,
  );
  const vault = matches.length === 1 ? matches[0] : undefined;
  if (!vault || (provider && !provider.isHolder(vault.id))) return DELEGATE;
  const clock = new Date(deps.now());
  const today: IsoDate = `${String(clock.getFullYear()).padStart(4, "0")}-${String(clock.getMonth() + 1).padStart(2, "0")}-${String(clock.getDate()).padStart(2, "0")}`;
  let cutoff: IsoDate | undefined;
  try {
    if (input.recentDays !== undefined) cutoff = addDays(today, -input.recentDays);
  } catch {
    return DELEGATE;
  }
  const initial = await vault.queue.run(() => {
    if (
      io.signal.aborted ||
      deps.stores.vaults.get(vault.id) !== vault ||
      mcpProfile(vault.store.read.bind(vault.store))?.slug !== slug ||
      (provider && !provider.isHolder(vault.id))
    )
      return null;
    return snapshot(vault);
  });
  if (initial === null) return io.signal.aborted ? 130 : DELEGATE;
  const bands =
    cutoff === undefined
      ? [{ model: input.model, tag: input.model || "llm", range: {} }]
      : [
          { model: input.recentModel, tag: input.recentModel, range: { dateFrom: cutoff } },
          { model: input.oldModel, tag: input.oldModel, range: { dateTo: addDays(cutoff, -1) } },
        ];
  const prepared = bands.map((band) => ({
    ...band,
    config: ollamaOptions(io, band.model),
    plan: budget.planReclassify(initial.rows, initial.ctx, {
      ...band.range,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    }),
  }));
  const networkNeeded = prepared.some((band) => band.plan.groups.length > 0);
  if (networkNeeded && !provider?.isHolder(vault.id)) return DELEGATE;
  if (
    prepared.some(
      (band) =>
        !band.config || !importTextSupported(band.config.model) || !importTextSupported(band.tag),
    )
  )
    return DELEGATE;
  // A complete worst-case distribution must fit before network/progress output starts.
  if (
    richTable(
      io,
      [{ header: "category" }, { header: "count", justify: "right" }],
      budget.RECLASSIFY_KEYS.map((key) => [key, String(initial.rows.length)]),
      "Category distribution",
    ) === null
  )
    return DELEGATE;
  const rows = new Map(initial.rows.map((r) => [r.key, r]));
  const claims: { txn: string; category: string }[] = [];
  const distribution = new Map<string, number>();
  let fallback = 0,
    groups = 0,
    targets = 0,
    configured = 0;
  try {
    for (const [index, band] of prepared.entries()) {
      if (!band.config) throw new Error("missing local classifier configuration");
      if (cutoff !== undefined) {
        const label = index === 0 ? `Last ${input.recentDays} days` : "Older";
        const text =
          index === 0
            ? `${label} (from ${cutoff}) → ${band.tag}`
            : `\n${label} (up to ${addDays(cutoff, -1)}) → ${band.tag}`;
        const start = index === 0 ? 0 : 1;
        printConsole(io, text, {
          spans: [{ start, end: start + label.length, style: { bold: true } }],
        });
      }
      const answers =
        band.plan.groups.length === 0
          ? new Map<string, budget.Answer>()
          : await new OllamaClassifier(
              provider as NonNullable<typeof provider>,
              vault.id,
              io,
              band.config,
            ).classifyTransactions(
              band.plan.groups.map((g) => [g.id, g.context] as const),
              band.plan.allowedKeys,
              band.plan.allowedLabels,
              {
                batchSize: input.batchSize,
                onProgress: (done, total) =>
                  printConsole(
                    { ...io, stdout: (text) => io.stdout(`${text.slice(0, -1)}\r`) },
                    `  ${band.tag}: … ${done}/${total} groups`,
                  ),
              },
            );
      const result = budget.applyReclassify(band.plan, rows, answers);
      for (const key of result.fallback) {
        const row = rows.get(key);
        if (!row) throw new Error("missing native classification row");
        const calculated = budget.categorize(row, initial.ctx, new Set());
        if (
          ["llm_full", "llm_fallback"].includes(row.source ?? "") ||
          calculated.category !== row.category ||
          calculated.source !== row.source
        ) {
          io.stderr(`${io.t.tr(S.unsupportedFallback)}\n`);
          return 1;
        }
        distribution.set(calculated.category, (distribution.get(calculated.category) ?? 0) + 1);
      }
      for (const claim of result.claims) {
        claims.push({ txn: claim.key, category: claim.category });
        distribution.set(claim.category, (distribution.get(claim.category) ?? 0) + 1);
      }
      fallback += result.fallback.length;
      groups += band.plan.groups.length;
      targets += band.plan.targets;
      configured += band.plan.configured.length;
    }
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
      (networkNeeded && !provider?.isHolder(vault.id))
    ) {
      io.stderr(`${io.t.tr(S.authorityChanged)}\n`);
      return 1;
    }
    if (snapshot(vault).stamp !== initial.stamp) {
      io.stderr(`${io.t.tr(S.contextChanged)}\n`);
      return 1;
    }
    const result = runCommand(
      vault.store,
      vault.writer,
      setLlmCategories,
      { items: claims },
      vault.env,
    );
    if (!result.ok || result.value.set !== claims.length)
      throw new Error("native classification refused unchanged planned rows");
    const model =
      cutoff === undefined
        ? prepared[0]?.config?.model
        : `${input.recentModel} (recent) + ${input.oldModel} (older)`;
    printConsole(io, "");
    const prefix = "Reclassification done";
    printConsole(
      io,
      `${prefix} (model ${model}): ${targets} transactions in ${groups} groups, LLM ${result.value.set}, fallback ${fallback}, by your rules / loan patterns ${configured}.`,
      { spans: [{ start: 0, end: prefix.length, style: { color: 32 } }] },
    );
    const table = richTable(
      io,
      [{ header: "category" }, { header: "count", justify: "right" }],
      [...distribution]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 25)
        .map(([key, count]) => [key, String(count)]),
      "Category distribution",
    );
    if (table === null) throw new Error("native classification table exceeded validated width");
    io.stdout(table);
    return 0;
  });
}
