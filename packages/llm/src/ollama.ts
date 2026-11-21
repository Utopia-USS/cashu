import { budget, PyJsonError, parsePyJson } from "@cashu/domain";
import {
  assertClassifierCurrent,
  ClassifierAuthorityLost,
  type ClassifierDiagnostic,
  type ClassifierTransportContext,
} from "./ports.js";

export interface OllamaOptions {
  readonly url: string;
  readonly model: string;
}

/** Restrict local classification to the same loopback endpoints as the existing host adapter. */
export function normalizeLoopbackUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return undefined;
  } catch {
    return undefined;
  }
  return raw.replace(/\/+$/, "");
}

function diagnostic(error: unknown): ClassifierDiagnostic {
  if (error instanceof PyJsonError) {
    const match =
      /^Expecting property name enclosed in double quotes: line (\d+) column (\d+) \(char (\d+)\)$/.exec(
        error.message,
      );
    if (match !== null) {
      return {
        backend: "ollama",
        reason: "malformed",
        parse: {
          kind: "expected_property_name",
          line: Number(match[1]),
          column: Number(match[2]),
          position: Number(match[3]),
        },
      };
    }
    return { backend: "ollama", reason: "malformed" };
  }
  return { backend: "ollama", reason: "unreachable" };
}

/** Leader-only local transport. Host owns environment lookup and user-facing diagnostics. */
export class OllamaClassifier implements budget.MerchantClassifier, budget.TransactionClassifier {
  readonly options: OllamaOptions;
  private readonly context: ClassifierTransportContext;

  constructor(context: ClassifierTransportContext, options: OllamaOptions) {
    const url = normalizeLoopbackUrl(options.url);
    if (url === undefined) throw new Error("local classifier requires a loopback endpoint");
    if (
      !context ||
      typeof context.vault !== "string" ||
      typeof context.isHolder !== "function" ||
      typeof context.isInputCurrent !== "function" ||
      typeof context.fetch !== "function" ||
      !context.signal
    )
      throw new ClassifierAuthorityLost();
    this.context = Object.freeze({
      vault: context.vault,
      isHolder: context.isHolder.bind(context),
      isInputCurrent: context.isInputCurrent.bind(context),
      fetch: context.fetch.bind(context),
      signal: context.signal,
      onDiagnostic: context.onDiagnostic?.bind(context),
    });
    this.options = Object.freeze({ url, model: options.model });
  }

  private check(): void {
    assertClassifierCurrent(this.context);
  }

  private async content(body: unknown, timeout: number): Promise<string | null> {
    this.check();
    try {
      const response = await this.context.fetch(`${this.options.url}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        redirect: "manual",
        signal: AbortSignal.any([this.context.signal, AbortSignal.timeout(timeout)]),
      });
      this.check();
      if (!response.ok) {
        this.context.onDiagnostic?.({
          backend: "ollama",
          reason: "unreachable",
          httpStatus: response.status,
        });
        return null;
      }
      const data = parsePyJson(await response.text());
      this.check();
      if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
      const message = (data as Record<string, unknown>).message;
      if (message === null || typeof message !== "object" || Array.isArray(message)) return null;
      const content = (message as Record<string, unknown>).content;
      if (typeof content !== "string") return null;
      parsePyJson(content);
      return content;
    } catch (error) {
      if (error instanceof ClassifierAuthorityLost) throw error;
      this.check();
      this.context.onDiagnostic?.(diagnostic(error));
      return null;
    }
  }

  async classifyMerchants(merchants: readonly string[], keys: readonly string[]) {
    this.check();
    const answers = new Map<string, budget.Answer>();
    for (const batch of budget.ollamaMerchantBatches(merchants, keys, {
      model: this.options.model,
    })) {
      const content = await this.content(batch.body, 180000);
      if (content === null) continue;
      const parsed = budget.parseOllamaMerchantReply(content, batch.ids, keys);
      if (parsed.ok) for (const [id, answer] of parsed.answers) answers.set(id, answer);
    }
    this.check();
    return answers.size
      ? { ok: true as const, answers }
      : { ok: false as const, reason: "empty" as const };
  }

  async classifyTransactions(
    items: readonly (readonly [string, string])[],
    keys: readonly string[],
    labels: ReadonlyMap<string, string>,
    opts: {
      readonly batchSize: number;
      readonly onProgress?: (done: number, total: number) => void;
    },
  ) {
    this.check();
    if (!Number.isSafeInteger(opts.batchSize) || opts.batchSize <= 0)
      throw new RangeError("batch size must be a positive safe integer");
    const answers = new Map<string, budget.Answer>();
    let done = 0;
    for (const batch of budget.ollamaTxnBatches(items, keys, labels, {
      model: this.options.model,
      batchSize: opts.batchSize,
    })) {
      const content = await this.content(batch.body, 300000);
      if (content !== null) {
        const parsed = budget.parseOllamaTxnReply(content, batch.ids, keys);
        if (parsed.ok) for (const [id, answer] of parsed.answers) answers.set(id, answer);
      }
      done += batch.ids.length;
      opts.onProgress?.(done, items.length);
    }
    this.check();
    return answers;
  }
}
