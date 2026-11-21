/**
 * The LLM classifier port (D-09.1): the domain defines what a classifier does; the HTTP adapters
 * (Ollama, Anthropic) live in a leader-only package (follow-up S09b) and never run on the phone.
 */

/** Why a batch or a whole call produced no answers (value-free: never the text or the reply). */
export type ClassifierFailure = "unreachable" | "empty" | "no_api_key" | "malformed";

export interface Answer {
  readonly category: string;
  /** Clamped to [0, 1]; never stored (Q18). */
  readonly confidence: number;
}

/** `classify.classify_unknown` / `classify_merchants` of both backends: merchant -> answer. */
export interface MerchantClassifier {
  classifyMerchants(
    merchants: readonly string[],
    categoryKeys: readonly string[],
  ): Promise<
    | { readonly ok: true; readonly answers: ReadonlyMap<string, Answer> }
    | { readonly ok: false; readonly reason: ClassifierFailure }
  >;
}

/** `local_llm.classify_transactions` (Ollama only, reclassify): item id -> answer. */
export interface TransactionClassifier {
  classifyTransactions(
    items: readonly (readonly [string, string])[],
    categoryKeys: readonly string[],
    labels: ReadonlyMap<string, string>,
    opts: {
      readonly batchSize: number;
      readonly onProgress?: (doneItems: number, itemCount: number) => void;
    },
  ): Promise<ReadonlyMap<string, Answer>>;
}
