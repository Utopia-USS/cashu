// Snapshot under the native queue, network outside it, then currentness-guarded atomic append.
import { budget } from "@cashu/domain";
import {
  AnthropicClassifier,
  assertClassifierCurrent,
  type ClassifierResult,
  type ClassifierTransportContext,
  type CurrentCloudConfig,
  type ReviewedCloudConsent,
} from "@cashu/llm";
import { cacheLlmRules, runCommand } from "@cashu/store";
import type { OpenVault } from "../../stores.js";
import { printConsole } from "../core/console.js";
import type { CommandIo } from "../tree.js";
import { S } from "./categorize.strings.js";
import {
  type CategorizeDeps,
  ClassifierAuthorityLost,
  hasClassifierAuthority,
  OllamaClassifier,
  ollamaOptions,
} from "./categorizeOllama.js";
import { classifierInput } from "./classifierInput.js";
import { importTextSupported } from "./importInput.js";

const DELEGATE = { kind: "delegate" } as const;
export async function runMerchantClassification(
  vault: OpenVault,
  slug: string,
  io: CommandIo,
  deps: CategorizeDeps,
): Promise<number | typeof DELEGATE> {
  const backend = () => (io.env.CASHU_CATEGORIZE_LLM_BACKEND || "ollama").toLowerCase();
  const cloud = backend() === "anthropic";
  const refuseCloud = () => {
    io.stderr(`${io.t.tr(S.cloudUnavailable)}\n${io.t.tr(S.cloudRisk)}\n`);
    return 1;
  };
  const initial = await vault.queue.run(() =>
    io.signal.aborted ? null : classifierInput(vault, slug, deps.stores.vaults),
  );
  if (initial === null) return io.signal.aborted ? 130 : cloud ? refuseCloud() : DELEGATE;
  let context: ClassifierTransportContext;
  let cloudGuard: { consent: ReviewedCloudConsent; config: CurrentCloudConfig } | undefined;
  let options: ReturnType<typeof ollamaOptions>;
  let answers: ClassifierResult;
  const merchants = cloud ? initial.merchants.cloud : initial.merchants.local;
  try {
    if (cloud) {
      const provider = deps.cloudClassifier;
      if (!provider) return refuseCloud();
      const consent = provider.consent(vault.id),
        config = provider.config(vault.id);
      if (!consent || !config || !provider.credentials) return refuseCloud();
      const selectedModel = config.model,
        selectedEndpoint = config.endpoint;
      const consentVault = consent.vault,
        riskCopy = consent.riskCopy;
      cloudGuard = {
        consent: {
          vault: consentVault,
          riskCopy,
          isCurrent: (id) => {
            const current = provider.consent(id);
            return (
              consent.isCurrent(id) &&
              current?.vault === id &&
              current.riskCopy === riskCopy &&
              current.isCurrent(id)
            );
          },
        },
        config: {
          model: selectedModel,
          endpoint: selectedEndpoint,
          isCurrent: (id) => {
            const current = provider.config(id);
            return (
              config.isCurrent(id) &&
              current?.model === selectedModel &&
              current.endpoint === selectedEndpoint &&
              current.isCurrent(id)
            );
          },
        },
      };
      context = {
        vault: vault.id,
        signal: io.signal,
        fetch: (request, init) => provider.fetch(request, init),
        isHolder: (id) => deps.cloudClassifier === provider && hasClassifierAuthority(provider, id),
        isInputCurrent: (id) => backend() === "anthropic" && initial.isCurrent(id),
      };
      assertClassifierCurrent(context, cloudGuard);
      // Keep the branded full-vault list intact. Full transaction contexts have no cloud path.
      answers =
        merchants.length === 0
          ? { ok: false, reason: "empty" }
          : await new AnthropicClassifier(
              context,
              cloudGuard.consent,
              provider.credentials,
              cloudGuard.config,
            ).classifyCloudMerchants(initial.merchants.cloud, budget.AUTO_CATEGORY_KEYS);
    } else {
      if (initial.merchants.local.length === 0) {
        if (io.signal.aborted) return 130;
        if (backend() !== "ollama" || !initial.isCurrent(vault.id)) {
          io.stderr(`${io.t.tr(S.contextChanged)}\n`);
          return 1;
        }
        const text = `Categorized ${initial.total} transactions.`;
        printConsole(io, text, { spans: [{ start: 0, end: text.length, style: { color: 32 } }] });
        printConsole(io, "  LLM: +0 rules (0 unknown expense merchants)");
        return 0;
      }
      const provider = deps.classifier;
      options = ollamaOptions(io);
      if (
        !provider ||
        !options ||
        backend() !== "ollama" ||
        !hasClassifierAuthority(provider, vault.id) ||
        !importTextSupported(options.model)
      )
        return DELEGATE;
      const selected = options;
      context = {
        vault: vault.id,
        signal: io.signal,
        fetch: (request, init) => provider.fetch(request, init),
        isHolder: (id) => deps.classifier === provider && hasClassifierAuthority(provider, id),
        isInputCurrent: (id) => {
          const current = ollamaOptions(io);
          return (
            backend() === "ollama" &&
            current?.url === selected.url &&
            current.model === selected.model &&
            initial.isCurrent(id)
          );
        },
      };
      answers = await new OllamaClassifier(
        { fetch: (request, init) => provider.fetch(request, init), isHolder: context.isHolder },
        vault.id,
        io,
        options,
        context.isInputCurrent,
      ).classifyMerchants(initial.merchants.local, budget.AUTO_CATEGORY_KEYS);
    }
  } catch (error) {
    if (io.signal.aborted) return 130;
    if (error instanceof ClassifierAuthorityLost) {
      io.stderr(`${io.t.tr(S.authorityChanged)}\n`);
      return 1;
    }
    if (cloud) return refuseCloud();
    throw error;
  }
  if (cloud && !answers.ok && answers.reason === "no_api_key") return refuseCloud();
  return vault.queue.run(() => {
    if (io.signal.aborted) return 130;
    try {
      assertClassifierCurrent(context, cloudGuard);
    } catch {
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
    const text = `Categorized ${initial.total} transactions.`;
    printConsole(io, text, { spans: [{ start: 0, end: text.length, style: { color: 32 } }] });
    if (answers.ok || merchants.length === 0)
      printConsole(io, `  LLM: +${cached} rules (${merchants.length} unknown expense merchants)`);
    else {
      const error = cloud
        ? io.t.tr(S.cloudEmpty)
        : `LLM skipped: Ollama returned nothing (is it running? model '${options?.model}' pulled?)`;
      printConsole(io, error, { spans: [{ start: 0, end: error.length, style: { color: 33 } }] });
    }
    return 0;
  });
}
