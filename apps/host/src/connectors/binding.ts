import { createHash } from "node:crypto";
import { type ConnectorCatalog, resolveInterpreter } from "./catalog.js";
import { ConnectorFault } from "./manifest.js";
import { type RunResult, runConnector } from "./runner.js";

export interface ConnectorBinding {
  readonly id: string;
  readonly profileId: string;
  readonly accountId: string;
  readonly connectorId: string;
  readonly module: "budget" | "investments";
  readonly enabled: boolean;
  readonly params: Readonly<Record<string, unknown>>;
  readonly cursor: string | null;
}
export interface BindingAccount {
  readonly id: string;
  readonly profileId: string;
  readonly module: "budget" | "investments";
  readonly currency: string;
  readonly label: string;
}
/** Host-only port backed by a per-binding OS KeyStore namespace; no secret enters the event store. */
export interface ConnectorSecretStore {
  get(profileId: string, bindingId: string, secretId: string): Promise<string | null>;
}
export interface FetchAuthority {
  readonly profileId: string;
  readonly holder: true;
  isCurrent(): boolean;
}

export interface TransportBinding {
  readonly id: string;
  readonly profileId: string;
  readonly accountId: string;
  readonly connectorId: string;
  readonly module: "budget" | "investments";
  readonly baseCursor: string | null;
  readonly paramsDigest: string;
  readonly approvedCodeDigest: string;
  readonly interpreter: string;
}

export function bindingParamsDigest(params: Readonly<Record<string, unknown>>): string {
  const stable = Object.entries(params).sort(([a], [b]) => a.localeCompare(b));
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

/** `stderrTail`: the redacted stderr tail of the connector process (owner view only), when it ran. */
export type BoundFetchResult =
  | {
      readonly outcome: "transported";
      readonly documentBytes: Uint8Array;
      readonly binding: TransportBinding;
      readonly newCursor: string | null;
      readonly stderrTail?: string | null;
    }
  | {
      readonly outcome: "refused" | "failed" | "timeout";
      readonly errorKind: string;
      readonly stderrTail?: string | null;
    };

function validParams(
  params: Readonly<Record<string, unknown>>,
  manifest: ReturnType<ConnectorCatalog["approved"]>["manifest"],
): boolean {
  const specs = manifest.fetch?.params ?? [];
  if (Object.keys(params).some((key) => !specs.some((spec) => spec.id === key))) return false;
  for (const spec of specs) {
    const value = params[spec.id];
    if (value === undefined || value === null || value === "") {
      if (spec.required) return false;
      continue;
    }
    if (spec.type === "boolean" && typeof value !== "boolean") return false;
    if (spec.type === "number" && (typeof value !== "number" || !Number.isFinite(value)))
      return false;
    if (spec.type === "string" && typeof value !== "string") return false;
    if (spec.type === "date" && (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)))
      return false;
  }
  return true;
}

/** A checked transport result. The caller must validate/preview and commit before saving its cursor. */
export async function runBoundFetch(input: {
  readonly catalog: ConnectorCatalog;
  readonly binding: ConnectorBinding;
  readonly account: BindingAccount;
  readonly authority: FetchAuthority;
  readonly secrets: ConnectorSecretStore;
  readonly interpreter: string;
  readonly since?: string | null;
}): Promise<BoundFetchResult> {
  const { binding, account, authority } = input;
  if (
    !authority.holder ||
    !authority.isCurrent() ||
    !binding.enabled ||
    binding.profileId !== authority.profileId ||
    account.profileId !== authority.profileId ||
    binding.accountId !== account.id ||
    binding.module !== account.module
  )
    return { outcome: "refused", errorKind: "bad_request" };
  let loaded: ReturnType<ConnectorCatalog["approved"]>;
  try {
    loaded = input.catalog.approved(binding.connectorId, input.interpreter);
  } catch (error) {
    return {
      outcome: "refused",
      errorKind:
        error instanceof ConnectorFault && error.kind === "missing" ? "missing" : "not_approved",
    };
  }
  if (
    loaded.manifest.kind !== "fetch" ||
    loaded.manifest.module !== binding.module ||
    !validParams(binding.params, loaded.manifest)
  )
    return { outcome: "refused", errorKind: "bad_request" };
  const params = { ...binding.params };
  const base: TransportBinding = Object.freeze({
    id: binding.id,
    profileId: binding.profileId,
    accountId: binding.accountId,
    connectorId: binding.connectorId,
    module: binding.module,
    baseCursor: binding.cursor,
    paramsDigest: bindingParamsDigest(params),
    approvedCodeDigest: loaded.contentSha256,
    interpreter: resolveInterpreter(loaded, input.catalog.bundledDeno),
  });
  const secrets: Record<string, string> = {};
  for (const spec of loaded.manifest.fetch?.secrets ?? []) {
    if (!authority.isCurrent()) return { outcome: "refused", errorKind: "bad_request" };
    let value: string | null;
    try {
      value = await input.secrets.get(binding.profileId, binding.id, spec.id);
    } catch {
      return { outcome: "refused", errorKind: "secret_unavailable" };
    }
    if (!value) return { outcome: "refused", errorKind: "missing_secret" };
    secrets[spec.id] = value;
  }
  if (!authority.isCurrent()) return { outcome: "refused", errorKind: "bad_request" };
  const result: RunResult = await runConnector({
    catalog: input.catalog,
    id: binding.connectorId,
    interpreter: input.interpreter,
    command: "fetch",
    params,
    account: { currency: account.currency, label: account.label },
    secrets,
    cursor: binding.cursor,
    since: input.since,
  });
  if (result.outcome !== "ok") return result;
  const stderr = result.stderrTail ? { stderrTail: result.stderrTail } : {};
  if (!authority.isCurrent()) return { outcome: "refused", errorKind: "bad_request", ...stderr };
  try {
    if (
      input.catalog.approved(binding.connectorId, input.interpreter).contentSha256 !==
      loaded.contentSha256
    )
      return { outcome: "refused", errorKind: "not_approved", ...stderr };
  } catch {
    return { outcome: "refused", errorKind: "not_approved", ...stderr };
  }
  const cursor =
    result.response &&
    typeof result.response === "object" &&
    "cursor" in result.response &&
    typeof result.response.cursor === "string"
      ? result.response.cursor
      : null;
  if (!result.documentBytes) return { outcome: "failed", errorKind: "protocol", ...stderr };
  return {
    outcome: "transported",
    documentBytes: result.documentBytes,
    binding: base,
    newCursor: cursor,
    ...stderr,
  };
}
