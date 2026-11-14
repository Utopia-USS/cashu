// Notification clicks. `NOTIFICATION_INTENT_METHOD`: a clicked notification's intent token resolved
// against the private intent ledger to the vault and screen it opens; anything short of an exact,
// current resolution answers `unavailable`. `hostNotifications`: the authority and notifier binding.
import {
  notificationResolveParamsSchema,
  notificationResolveResultSchema,
} from "@cashu/host-protocol";
import type { HostSession } from "@cashu/node-host";
import {
  type HostNotificationCapability,
  hostNotificationCapability,
} from "../notificationCapability.js";
import type { privateNotificationIntents } from "../notifications/intentLedger.js";
import { type IntentVaultAuthority, resolveNotificationIntent } from "../notifications/resolve.js";
import type { HostStores } from "../stores.js";
import { type RequestFrame, type RequestScope, serveTrackedRequest } from "./requests.js";

const MIN_PROTOCOL_MINOR = 4;

export function serveNotificationRequest(
  scope: RequestScope & {
    readonly intents: ReturnType<typeof privateNotificationIntents> | undefined;
    readonly authority: IntentVaultAuthority;
    readonly stores: HostStores;
    readonly now: () => number;
  },
  session: HostSession,
  frame: RequestFrame,
): void {
  const parsed = notificationResolveParamsSchema.safeParse(frame.params);
  const bound = scope.intents;
  serveTrackedRequest(
    scope,
    session,
    frame,
    async () => {
      const target =
        session.protocol.minor >= MIN_PROTOCOL_MINOR &&
        !scope.closing() &&
        parsed.success &&
        bound !== undefined
          ? await resolveNotificationIntent(
              bound,
              scope.stores,
              scope.authority,
              parsed.data.requestId,
              parsed.data.intentToken,
              scope.now,
            )
          : null;
      const result = notificationResolveResultSchema.parse(
        target === null
          ? { kind: "unavailable" }
          : {
              kind: "target",
              vaultId: target.vaultId,
              target: target.kind,
              ...(target.kind === "signal" ? { signalId: target.signalId } : {}),
            },
      );
      return { result };
    },
    { kind: "unavailable" },
  );
}

/**
 * The intent authority and the notifier capability, both pinned to this host: a vault resolves
 * only while it is the open, current native vault and the host holds its lock and is not closing.
 * The ledger survives a restart and the worker's notifier submits through the same authority.
 */
export function hostNotifications(input: {
  readonly intents: ReturnType<typeof privateNotificationIntents> | undefined;
  readonly stores: HostStores;
  readonly lock: { readonly held: boolean };
  readonly closing: () => boolean;
}): {
  readonly authority: IntentVaultAuthority;
  readonly capability: HostNotificationCapability | undefined;
} {
  const { intents, stores, lock, closing } = input;
  const authority: IntentVaultAuthority = {
    isAdmittedAndUnlocked: (vault) =>
      stores.vaults.get(vault.id) === vault &&
      vault.mode === "native" &&
      vault.native.isCurrent() &&
      !closing() &&
      lock.held,
  };
  const capability =
    intents === undefined
      ? undefined
      : hostNotificationCapability(intents, () => !closing() && lock.held);
  return { authority, capability };
}
