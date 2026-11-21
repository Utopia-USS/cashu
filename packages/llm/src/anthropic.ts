// Explicit injected merchant-only egress. Full transaction context has no cloud transport method.
import { budget, parsePyJson } from "@cashu/domain";
import {
  assertClassifierCurrent,
  ClassifierAuthorityLost,
  type ClassifierResult,
  type ClassifierTransportContext,
  type CloudCredentials,
  type CloudMerchantClassifier,
  type CurrentCloudConfig,
  type ReviewedCloudConsent,
} from "./ports.js";

const ENDPOINT = "https://api.anthropic.com/v1/messages";
const VERSION = "2023-06-01";
const TIMEOUT_MS = 60_000;

export class AnthropicClassifier implements CloudMerchantClassifier {
  private readonly context: ClassifierTransportContext;
  private readonly consent: ReviewedCloudConsent;
  private readonly credentials: CloudCredentials;
  private readonly config: CurrentCloudConfig;

  constructor(
    context: ClassifierTransportContext,
    consent: ReviewedCloudConsent,
    credentials: CloudCredentials,
    config: CurrentCloudConfig,
  ) {
    // Required in TS and refused at the actual JS boundary too. Never infer capabilities from env,
    // a backend flag, MCP privacy mode or a placeholder lease.
    if (
      !context ||
      !consent ||
      !credentials ||
      !config ||
      typeof context.vault !== "string" ||
      typeof context.fetch !== "function" ||
      !context.signal ||
      typeof context.isHolder !== "function" ||
      typeof context.isInputCurrent !== "function" ||
      typeof consent.isCurrent !== "function" ||
      typeof credentials.apiKey !== "function" ||
      typeof config.isCurrent !== "function" ||
      consent.vault !== context.vault ||
      consent.riskCopy !== "merchant-name-residual-v1"
    ) {
      throw new ClassifierAuthorityLost();
    }
    if (config.endpoint !== ENDPOINT || typeof config.model !== "string" || !config.model) {
      throw new Error("invalid cloud classifier configuration");
    }
    this.context = Object.freeze({
      vault: context.vault,
      signal: context.signal,
      fetch: context.fetch.bind(context),
      isHolder: context.isHolder.bind(context),
      isInputCurrent: context.isInputCurrent.bind(context),
      ...(context.onDiagnostic === undefined
        ? {}
        : { onDiagnostic: context.onDiagnostic.bind(context) }),
    });
    this.consent = Object.freeze({
      vault: consent.vault,
      riskCopy: consent.riskCopy,
      isCurrent: consent.isCurrent.bind(consent),
    });
    this.credentials = Object.freeze({ apiKey: credentials.apiKey.bind(credentials) });
    this.config = Object.freeze({
      model: config.model,
      endpoint: config.endpoint,
      isCurrent: config.isCurrent.bind(config),
    });
  }

  private check(signal?: AbortSignal): void {
    assertClassifierCurrent(this.context, { consent: this.consent, config: this.config });
    if (signal?.aborted) throw new Error("cloud classifier request expired");
  }

  private diagnostic(reason: budget.ClassifierFailure): void {
    this.context.onDiagnostic?.({ backend: "anthropic", reason });
  }

  async classifyCloudMerchants(
    merchants: readonly budget.CloudMerchant[],
    categoryKeys: readonly string[],
  ): Promise<ClassifierResult> {
    this.check();
    // Retain the cloud brand and a stable request/parser plan across awaits. No plain strings are
    // cast into eligibility; the shared builder still applies its existing second privacy filter.
    const keys = [...categoryKeys];
    const batches = budget.anthropicMerchantBatches([...merchants], keys, {
      model: this.config.model,
    });
    const answers = new Map<string, budget.Answer>();
    let failure: budget.ClassifierFailure = "empty";
    for (const batch of batches) {
      this.check();
      if ("ok" in batch) {
        failure = "malformed";
        this.diagnostic(failure);
        continue;
      }
      let apiKey: string | null;
      try {
        apiKey = await this.credentials.apiKey(this.context.vault);
        this.check();
      } catch (error) {
        if (error instanceof ClassifierAuthorityLost) throw error;
        this.check();
        this.diagnostic("no_api_key");
        return { ok: false, reason: "no_api_key" };
      }
      if (typeof apiKey !== "string" || !apiKey) {
        this.diagnostic("no_api_key");
        return { ok: false, reason: "no_api_key" };
      }
      const signal = AbortSignal.any([this.context.signal, AbortSignal.timeout(TIMEOUT_MS)]);
      try {
        this.check(signal);
        const response = await this.context.fetch(ENDPOINT, {
          method: "POST",
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": VERSION,
            "content-type": "application/json",
          },
          body: JSON.stringify(batch.body),
          redirect: "manual",
          signal,
        });
        this.check(signal);
        if (!response.ok || response.redirected) {
          failure = "unreachable";
          this.diagnostic(failure);
          continue;
        }
        const text = await response.text();
        this.check(signal);
        let data: unknown;
        try {
          data = parsePyJson(text);
        } catch {
          failure = "malformed";
          this.diagnostic(failure);
          continue;
        }
        const result = budget.parseAnthropicReply(data, batch.ids, keys);
        if (result.ok) {
          for (const [merchant, answer] of result.answers) answers.set(merchant, answer);
        } else {
          failure = "malformed";
          this.diagnostic(failure);
        }
      } catch (error) {
        if (error instanceof ClassifierAuthorityLost) throw error;
        this.check();
        failure = "unreachable";
        this.diagnostic(failure);
      }
    }
    this.check();
    return answers.size ? { ok: true, answers } : { ok: false, reason: failure };
  }
}
