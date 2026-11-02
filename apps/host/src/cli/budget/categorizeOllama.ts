// Explicitly injected local classifier transport. Never infer authority from the scaffold lease.
import { budget, PyJsonError, parsePyJson } from "@cashu/domain";
import type { HostStores } from "../../stores.js";
import type { CommandIo } from "../tree.js";

export interface CategorizeProvider {
  /** Real existing fetch authority for this vault; checked before requests and after awaits. */
  readonly isHolder: (vault: string) => boolean;
  readonly fetch: typeof globalThis.fetch;
}
export interface CategorizeDeps {
  readonly stores: Pick<HostStores, "vaults">;
  readonly now: () => number;
  readonly classifier?: CategorizeProvider;
}
export interface OllamaOptions {
  readonly url: string;
  readonly model: string;
}
function localUrl(raw: string): string | undefined {
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
export function ollamaOptions(io: CommandIo, model?: string): OllamaOptions | undefined {
  const url = localUrl(io.env.CASHU_CATEGORIZE_OLLAMA_URL ?? "http://localhost:11434");
  if (url === undefined) return undefined;
  return {
    url,
    model: model || io.env.CASHU_CATEGORIZE_OLLAMA_MODEL || budget.OLLAMA_DEFAULT_MODEL,
  };
}
export class ClassifierAuthorityLost extends Error {
  constructor() {
    super("local classifier authority changed");
  }
}
export class OllamaClassifier implements budget.MerchantClassifier, budget.TransactionClassifier {
  readonly options: OllamaOptions;
  private readonly provider: CategorizeProvider;
  private readonly vault: string;
  private readonly io: CommandIo;
  constructor(provider: CategorizeProvider, vault: string, io: CommandIo, options: OllamaOptions) {
    const url = localUrl(options.url);
    if (url === undefined) throw new Error("local classifier requires a loopback endpoint");
    this.provider = provider;
    this.vault = vault;
    this.io = io;
    this.options = Object.freeze({ url, model: options.model });
  }
  private check(): void {
    if (this.io.signal.aborted || !this.provider.isHolder(this.vault))
      throw new ClassifierAuthorityLost();
  }
  private async content(body: unknown, timeout: number): Promise<string | null> {
    this.check();
    try {
      const response = await this.provider.fetch(`${this.options.url}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        // HTTPX's default is not to follow redirects; retain the response for its error text.
        redirect: "manual",
        signal: AbortSignal.any([this.io.signal, AbortSignal.timeout(timeout)]),
      });
      this.check();
      if (!response.ok) {
        const kind =
          new Map([
            [1, "Informational response"],
            [3, "Redirect response"],
            [4, "Client error"],
            [5, "Server error"],
          ]).get(Math.floor(response.status / 100)) ?? "Invalid status code";
        const location = [301, 302, 303, 307, 308].includes(response.status)
          ? response.headers.get("location")
          : null;
        this.io.stderr(
          `[local_llm] batch failed: ${kind} '${response.status} ${response.statusText}' for url '${new URL(`${this.options.url}/api/chat`)}'\n${location === null ? "" : `Redirect location: '${location}'\n`}For more information check: https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/${response.status}\n`,
        );
        return null;
      }
      const data = parsePyJson(await response.text());
      this.check();
      if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
      const message = (data as Record<string, unknown>).message;
      if (message === null || typeof message !== "object" || Array.isArray(message)) return null;
      const content = (message as Record<string, unknown>).content;
      if (typeof content !== "string") return null;
      // The shared parser reports Python's JSONDecodeError positions without echoing reply data.
      parsePyJson(content);
      return content;
    } catch (error) {
      if (
        error instanceof ClassifierAuthorityLost ||
        this.io.signal.aborted ||
        !this.provider.isHolder(this.vault)
      )
        throw new ClassifierAuthorityLost();
      this.io.stderr(
        `[local_llm] batch failed: ${error instanceof PyJsonError ? error.message : "local request failed"}\n`,
      );
      return null;
    }
  }
  async classifyMerchants(merchants: readonly string[], keys: readonly string[]) {
    const answers = new Map<string, budget.Answer>();
    for (const batch of budget.ollamaMerchantBatches(merchants, keys, {
      model: this.options.model,
    })) {
      const content = await this.content(batch.body, 180000);
      if (content === null) continue;
      const parsed = budget.parseOllamaMerchantReply(content, batch.ids, keys);
      if (parsed.ok) for (const [id, answer] of parsed.answers) answers.set(id, answer);
    }
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
    return answers;
  }
}
