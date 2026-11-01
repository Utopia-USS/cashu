/**
 * Request bodies of the LLM backends, batch by batch (`local_llm.classify_merchants` /
 * `classify_transactions`, `llm._build_payload`). Pure: the adapter (S09b) posts them.
 */

import { looksLikePerson } from "../../../core/index.js";
import { pyDumpsStrList } from "../../../pyJson.js";
import {
  ANTHROPIC_MERCHANT_PREFIX,
  anthropicSystemText,
  OLLAMA_MERCHANT_PREFIX,
  OLLAMA_TXN_PREFIX,
  ollamaMerchantSystemPrompt,
  ollamaTxnSystemPrompt,
} from "./prompts.js";
import { anthropicSchema, ollamaSchema } from "./schemas.js";

/** `local_llm` / `llm` defaults (the settings defaults are the same models). */
export const OLLAMA_DEFAULT_MODEL = "qwen2.5:3b";
export const OLLAMA_BATCH_SIZE = 20;
export const ANTHROPIC_DEFAULT_MODEL = "claude-haiku-4-5";
export const ANTHROPIC_BATCH_SIZE = 40;

/** One merchant batch: its ids (`m0`, `m1`, ... per batch) -> merchant, and the request body. */
export interface MerchantBatch {
  readonly ids: ReadonlyMap<string, string>;
  readonly body: unknown;
}

/** One transaction batch: its item ids (`t<i>`) and the request body. */
export interface TxnBatch {
  readonly ids: readonly string[];
  readonly body: unknown;
}

interface BatchOptions {
  readonly model?: string;
  readonly batchSize?: number;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += size)
    out.push(items.slice(start, start + size));
  return out;
}

/** `dict.fromkeys(m for m in merchants if m)`: non-empty, first occurrence kept. */
function uniqueMerchants(merchants: readonly string[]): string[] {
  return [...new Set(merchants.filter((m) => m))];
}

function ollamaBody(model: string, schema: unknown, system: string, user: string): unknown {
  return {
    model,
    stream: false,
    format: schema,
    options: { temperature: 0 },
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };
}

/** `local_llm.classify_merchants` request bodies (local: the merchant strings stay on the machine). */
export function ollamaMerchantBatches(
  merchants: readonly string[],
  categoryKeys: readonly string[],
  opts: BatchOptions = {},
): MerchantBatch[] {
  const schema = ollamaSchema(categoryKeys);
  const system = ollamaMerchantSystemPrompt(categoryKeys);
  const model = opts.model ?? OLLAMA_DEFAULT_MODEL;
  return chunks(uniqueMerchants(merchants), opts.batchSize ?? OLLAMA_BATCH_SIZE).map((batch) => {
    const ids = new Map(batch.map((m, i) => [`m${i}`, m]));
    const listing = [...ids].map(([k, v]) => `${k}: ${v}`).join("\n");
    return { ids, body: ollamaBody(model, schema, system, OLLAMA_MERCHANT_PREFIX + listing) };
  });
}

/** `local_llm.classify_transactions` request bodies: `[id]` + context per item. */
export function ollamaTxnBatches(
  items: readonly (readonly [string, string])[],
  categoryKeys: readonly string[],
  labels: ReadonlyMap<string, string>,
  opts: BatchOptions = {},
): TxnBatch[] {
  const schema = ollamaSchema(categoryKeys);
  const system = ollamaTxnSystemPrompt(labels);
  const model = opts.model ?? OLLAMA_DEFAULT_MODEL;
  return chunks(items, opts.batchSize ?? OLLAMA_BATCH_SIZE).map((batch) => {
    const listing = batch.map(([id, ctx]) => `[${id}]\n${ctx}`).join("\n\n");
    return {
      ids: batch.map(([id]) => id),
      body: ollamaBody(model, schema, system, OLLAMA_TXN_PREFIX + listing),
    };
  });
}

/**
 * `llm._build_payload` per batch for the cloud backend. The input is merchant strings only (the
 * privacy contract: no amounts, dates, IBANs or names are accepted). FIX(Q12, D-09.5d): a merchant
 * that looks like a person's name (a transfer to a person: `merchant_key` takes the counterparty
 * name first) is never sent; it stays `default` / `other`. A batch holding a lone surrogate (not
 * encodable, Python would fail it) is refused as `malformed`.
 */
export function anthropicMerchantBatches(
  merchants: readonly string[],
  categoryKeys: readonly string[],
  opts: BatchOptions = {},
): (MerchantBatch | { readonly ok: false; readonly reason: "malformed" })[] {
  const unique = uniqueMerchants(merchants).filter((m) => !looksLikePerson(m));
  if (unique.length === 0 || categoryKeys.length === 0) return [];
  const model = opts.model ?? ANTHROPIC_DEFAULT_MODEL;
  const system = [
    { type: "text", text: anthropicSystemText(categoryKeys), cache_control: { type: "ephemeral" } },
  ];
  const schema = anthropicSchema(categoryKeys);
  return chunks(unique, opts.batchSize ?? ANTHROPIC_BATCH_SIZE).map((batch) => {
    const ids = new Map(batch.map((m, i) => [`m${i}`, m]));
    const listing = pyDumpsStrList([...ids].map(([id, merchant]) => ({ id, merchant })));
    if (listing === null) return { ok: false, reason: "malformed" } as const;
    return {
      ids,
      body: {
        model,
        max_tokens: Math.min(16000, 80 * batch.length + 256),
        system,
        messages: [{ role: "user", content: ANTHROPIC_MERCHANT_PREFIX + listing }],
        output_config: { format: { type: "json_schema", schema } },
      },
    };
  });
}
