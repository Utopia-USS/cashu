import type { budget } from "@cashu/domain";

/** Only value-free diagnostics cross the transport boundary. */
export interface ClassifierDiagnostic {
  readonly backend: "ollama" | "anthropic";
  readonly reason: budget.ClassifierFailure;
  /** Local HTTP status only; response headers, body and redirect target never cross this port. */
  readonly httpStatus?: number;
  /** Whitelisted static parser condition and position, never raw JSON text or a key. */
  readonly parse?: {
    readonly kind: "expected_property_name";
    readonly line: number;
    readonly column: number;
    readonly position: number;
  };
}

/** Injected by a leader with actual authority and a current whole-vault input snapshot. */
export interface ClassifierTransportContext {
  readonly vault: string;
  readonly isHolder: (vault: string) => boolean;
  readonly isInputCurrent: (vault: string) => boolean;
  readonly fetch: typeof globalThis.fetch;
  readonly signal: AbortSignal;
  readonly onDiagnostic?: (event: ClassifierDiagnostic) => void;
}

/** The accepted residual merchant-name risk is reviewed separately for each vault. */
export interface ReviewedCloudConsent {
  readonly vault: string;
  readonly riskCopy: "merchant-name-residual-v1";
  readonly isCurrent: (vault: string) => boolean;
}

/** Credential lookup occurs only after all currentness checks and before a cloud request. */
export interface CloudCredentials {
  readonly apiKey: (vault: string) => Promise<string | null>;
}

/** The adapter copies and validates this configuration before use. */
export interface CurrentCloudConfig {
  readonly model: string;
  readonly endpoint: string;
  readonly isCurrent: (vault: string) => boolean;
}

export type ClassifierResult =
  | { readonly ok: true; readonly answers: ReadonlyMap<string, budget.Answer> }
  | { readonly ok: false; readonly reason: budget.ClassifierFailure };

/** Distinct from the generic local merchant classifier, preserving the cloud brand end to end. */
export interface CloudMerchantClassifier {
  classifyCloudMerchants(
    merchants: readonly budget.CloudMerchant[],
    categoryKeys: readonly string[],
  ): Promise<ClassifierResult>;
}

export class ClassifierAuthorityLost extends Error {
  constructor() {
    super("classifier authority changed");
    this.name = "ClassifierAuthorityLost";
  }
}

export function assertClassifierCurrent(
  context: ClassifierTransportContext,
  cloud?: { readonly consent: ReviewedCloudConsent; readonly config: CurrentCloudConfig },
): void {
  try {
    if (
      context.signal.aborted ||
      !context.isHolder(context.vault) ||
      !context.isInputCurrent(context.vault) ||
      (cloud !== undefined &&
        (cloud.consent.vault !== context.vault ||
          cloud.consent.riskCopy !== "merchant-name-residual-v1" ||
          !cloud.consent.isCurrent(context.vault) ||
          !cloud.config.isCurrent(context.vault)))
    ) {
      throw new ClassifierAuthorityLost();
    }
  } catch {
    // A provider failure is a lost capability, never a transport retry or classifier fallback.
    throw new ClassifierAuthorityLost();
  }
}
