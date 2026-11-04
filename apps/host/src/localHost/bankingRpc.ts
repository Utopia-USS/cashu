// `native.banking.*`: configure Enable Banking for a vault (an owner action) and allow the browser
// to open exactly the pending consent URL. Both need the open, current native vault with the budget
// module, this live UI session and the host lock, before and after the owner action.
import {
  bankingConfigureParamsSchema,
  bankingConsentUrlParamsSchema,
  bankingNativeResultSchema,
  NATIVE_BANKING_FEATURE,
  uiBankingAllowed,
} from "@cashu/host-protocol";
import type { HostSession } from "@cashu/node-host";
import { enabledModuleIds } from "@cashu/store/core";
import { runBankingOwnerAction } from "../banking/ownerAction.js";
import type { BankingRuntime } from "../banking/runtime.js";
import type { HostStores } from "../stores.js";
import {
  type RequestFrame,
  type RequestScope,
  refuseUnavailableMethod,
  serveTrackedRequest,
} from "./requests.js";

type BankingScope = RequestScope & {
  readonly nativeMode: boolean;
  readonly banking: (() => BankingRuntime | undefined) | undefined;
  readonly stores: HostStores;
  readonly lock: { readonly held: boolean };
  readonly bundleReplaced: () => boolean;
};

export function serveBankingRequest(
  scope: BankingScope,
  session: HostSession,
  frame: RequestFrame,
  sessionCurrent: () => boolean,
): void {
  if (
    !scope.nativeMode ||
    scope.closing() ||
    !uiBankingAllowed(frame.method, session.protocol.minor, [NATIVE_BANKING_FEATURE])
  ) {
    refuseUnavailableMethod(session, frame);
    return;
  }
  const configure = frame.method === "native.banking.configure";
  serveTrackedRequest(
    scope,
    session,
    frame,
    async () => ({
      result: bankingNativeResultSchema.parse(
        configure
          ? await configureBanking(scope, frame, sessionCurrent)
          : await allowConsentUrl(scope, frame, sessionCurrent),
      ),
    }),
    configure ? { kind: "outcome_unknown" } : { kind: "refused", code: "unavailable" },
  );
}

/** The owner-action predicate for `vaultId`, bound to the vault open right now. */
function ownerActionCurrent(
  scope: BankingScope,
  vaultId: string,
  sessionCurrent: () => boolean,
): () => boolean {
  const { stores } = scope;
  const vault = stores.vaults.get(vaultId);
  return () =>
    sessionCurrent() &&
    !scope.bundleReplaced() &&
    scope.lock.held &&
    vault?.mode === "native" &&
    stores.vaults.get(vaultId) === vault &&
    vault.native.isCurrent() &&
    enabledModuleIds(vault.store.read.bind(vault.store)).has("budget");
}

async function configureBanking(
  scope: BankingScope,
  frame: RequestFrame,
  sessionCurrent: () => boolean,
) {
  const runtime = scope.banking?.();
  if (!runtime || !scope.lock.held) return { kind: "refused", code: "unavailable" } as const;
  const input = bankingConfigureParamsSchema.safeParse(frame.params);
  if (!input.success) return { kind: "refused", code: "invalid_input" } as const;
  const current = ownerActionCurrent(scope, input.data.vaultId, sessionCurrent);
  if (!current()) return { kind: "refused", code: "authorization" } as const;
  const result = await runtime.withOwnerAction(input.data.vaultId, current, () =>
    runBankingOwnerAction({
      runtime,
      profileId: input.data.vaultId,
      isOwnerAction: current,
      action: {
        type: "configure",
        appId: input.data.appId,
        keyFilePath: input.data.keyFilePath,
      },
    }),
  );
  if (!current() || (!result.ok && result.error === "outcome_unknown"))
    return { kind: "outcome_unknown" } as const;
  return result.ok
    ? ({ kind: "configured" } as const)
    : ({
        kind: "refused",
        code: result.error === "configuration" ? "configuration" : "authorization",
      } as const);
}

async function allowConsentUrl(
  scope: BankingScope,
  frame: RequestFrame,
  sessionCurrent: () => boolean,
) {
  const runtime = scope.banking?.();
  if (!runtime || !scope.lock.held) return { kind: "refused", code: "unavailable" } as const;
  const input = bankingConsentUrlParamsSchema.safeParse(frame.params);
  if (!input.success) return { kind: "refused", code: "invalid_input" } as const;
  const current = ownerActionCurrent(scope, input.data.vaultId, sessionCurrent);
  if (!current()) return { kind: "refused", code: "authorization" } as const;
  const status = await runtime.withOwnerAction(input.data.vaultId, current, async () =>
    runtime.service(input.data.vaultId)?.status(),
  );
  return current() && status?.pendingConsent === input.data.url
    ? ({ kind: "allowed" } as const)
    : ({ kind: "refused", code: "authorization" } as const);
}
