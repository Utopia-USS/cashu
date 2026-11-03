// Host configuration and source-compatible diagnostics around the neutral local transport.
import { STATUS_CODES } from "node:http";
import { budget } from "@cashu/domain";
import {
  type ClassifierDiagnostic,
  type CloudCredentials,
  type CurrentCloudConfig,
  OllamaClassifier as LocalClassifier,
  normalizeLoopbackUrl,
  type OllamaOptions,
  type ReviewedCloudConsent,
} from "@cashu/llm";
import type { HostStores } from "../../stores.js";
import type { CommandIo } from "../tree.js";

export type { OllamaOptions } from "@cashu/llm";
export { ClassifierAuthorityLost } from "@cashu/llm";

export interface CategorizeProvider {
  readonly isHolder: (vault: string) => boolean;
  readonly fetch: typeof globalThis.fetch;
}
export function hasClassifierAuthority(
  provider: CategorizeProvider | undefined,
  vault: string,
): boolean {
  try {
    return provider?.isHolder(vault) === true;
  } catch {
    return false;
  }
}
export interface CloudCategorizeProvider extends CategorizeProvider {
  readonly consent: (vault: string) => ReviewedCloudConsent | null;
  readonly config: (vault: string) => CurrentCloudConfig | null;
  readonly credentials: CloudCredentials;
}
export interface CategorizeDeps {
  readonly stores: Pick<HostStores, "vaults">;
  readonly now: () => number;
  readonly classifier?: CategorizeProvider;
  /** Explicit native capability only; no inherited backend setting grants cloud consent. */
  readonly cloudClassifier?: CloudCategorizeProvider;
}

export function ollamaOptions(io: CommandIo, model?: string): OllamaOptions | undefined {
  const url = normalizeLoopbackUrl(io.env.CASHU_CATEGORIZE_OLLAMA_URL ?? "http://localhost:11434");
  return url === undefined
    ? undefined
    : {
        url,
        model: model || io.env.CASHU_CATEGORIZE_OLLAMA_MODEL || budget.OLLAMA_DEFAULT_MODEL,
      };
}

function reportLocal(io: CommandIo, options: OllamaOptions, event: ClassifierDiagnostic): void {
  if (event.httpStatus !== undefined) {
    const status = event.httpStatus;
    const kind =
      new Map([
        [1, "Informational response"],
        [3, "Redirect response"],
        [4, "Client error"],
        [5, "Server error"],
      ]).get(Math.floor(status / 100)) ?? "Invalid status code";
    io.stderr(
      `[local_llm] batch failed: ${kind} '${status} ${STATUS_CODES[status] ?? ""}' for url '${new URL(`${options.url}/api/chat`)}'\nFor more information check: https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/${status}\n`,
    );
    return;
  }
  const parse = event.parse;
  const message =
    parse === undefined
      ? "local request failed"
      : `Expecting property name enclosed in double quotes: line ${parse.line} column ${parse.column} (char ${parse.position})`;
  io.stderr(`[local_llm] batch failed: ${message}\n`);
}

export class OllamaClassifier implements budget.MerchantClassifier, budget.TransactionClassifier {
  readonly options: OllamaOptions;
  private readonly client: LocalClassifier;

  constructor(
    provider: CategorizeProvider,
    vault: string,
    io: CommandIo,
    options: OllamaOptions,
    isInputCurrent?: (vault: string) => boolean,
  ) {
    this.client = new LocalClassifier(
      {
        vault,
        isHolder: (id) => hasClassifierAuthority(provider, id),
        fetch: (request, init) => provider.fetch(request, init),
        signal: io.signal,
        // Missing currentness is unavailable, never an inferred production grant.
        isInputCurrent: (id) => isInputCurrent?.(id) === true,
        onDiagnostic: (event) => reportLocal(io, this.client.options, event),
      },
      options,
    );
    this.options = this.client.options;
  }

  classifyMerchants(merchants: readonly string[], keys: readonly string[]) {
    return this.client.classifyMerchants(merchants, keys);
  }
  classifyTransactions(
    items: readonly (readonly [string, string])[],
    keys: readonly string[],
    labels: ReadonlyMap<string, string>,
    opts: {
      readonly batchSize: number;
      readonly onProgress?: (done: number, total: number) => void;
    },
  ) {
    return this.client.classifyTransactions(items, keys, labels, opts);
  }
}
