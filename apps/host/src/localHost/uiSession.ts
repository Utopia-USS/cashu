// The `ui` role: the store channel (queries, commands, actions) plus the UI-role host RPCs, routed
// by method family to notification, connector install, banking, pairing, devices, relay and creation.
import { NOTIFICATION_INTENT_METHOD } from "@cashu/host-protocol";
import type { HostSession, RunningHost } from "@cashu/node-host";
import type { BankingRuntime } from "../banking/runtime.js";
import { connectorInstallRpc } from "../connectorInstallRpc.js";
import type { DeviceService } from "../devices/service.js";
import type { HostLog } from "../log.js";
import type { createNativeCreationService } from "../nativeCreation.js";
import { serveNativeCreationRequest } from "../nativeCreationRpc.js";
import type { privateNotificationIntents } from "../notifications/intentLedger.js";
import type { IntentVaultAuthority } from "../notifications/resolve.js";
import type { PairingService } from "../pairing/service.js";
import { serveNativePairingRequest } from "../pairingRpc.js";
import type { HostRelay } from "../relay/service.js";
import { type StoreChannelOptions, serveStoreChannel } from "../storeChannel.js";
import type { HostStores } from "../stores.js";
import { serveBankingRequest } from "./bankingRpc.js";
import { serveDevicesRequest } from "./devicesRpc.js";
import { serveNotificationRequest } from "./notificationRpc.js";
import type { LocalHostOptions } from "./options.js";
import { serveRelayRequest } from "./relayRpc.js";
import type { RequestFrame, RequestScope } from "./requests.js";

interface HostRpcDeps extends RequestScope {
  readonly nativeMode: boolean;
  readonly server: RunningHost;
  readonly stores: HostStores;
  readonly now: () => number;
  readonly log: HostLog;
  readonly connectorCatalog: LocalHostOptions["connectorCatalog"];
  readonly banking: (() => BankingRuntime | undefined) | undefined;
  readonly creation: ReturnType<typeof createNativeCreationService> | undefined;
  readonly devices: DeviceService;
  /** Device pairing over the sync relay; absent in safe mode and on a synthetic harness. */
  readonly pairing: PairingService | undefined;
  readonly relay: HostRelay;
  readonly notificationIntents: ReturnType<typeof privateNotificationIntents> | undefined;
  readonly notificationAuthority: IntentVaultAuthority;
  readonly bundleReplaced: () => boolean;
  /** Stops the host with a handover now. */
  readonly handover: () => void;
  /** Stops the host with a handover from a later task. */
  readonly handoverSoon: () => void;
}

type StoreChannel = Pick<
  StoreChannelOptions,
  | "queries"
  | "commands"
  | "actions"
  | "prepareQuery"
  | "privateQuery"
  | "maxInFlight"
  | "afterCommit"
>;

/** Serves `ui` sessions; host RPCs only when this host has any (native, creation, connectors). */
export function createUiSessions(deps: {
  readonly rpc: HostRpcDeps;
  readonly channel: StoreChannel;
}): (session: HostSession) => void {
  const { rpc, channel } = deps;
  return (session) => {
    let sessionOpen = true;
    session.onClose(() => {
      sessionOpen = false;
    });
    const installConnector = connectorInstallRpc(session, () => rpc.connectorCatalog?.());
    const hasHostRpc =
      rpc.creation !== undefined ||
      rpc.notificationIntents !== undefined ||
      rpc.connectorCatalog !== undefined ||
      rpc.nativeMode;
    serveStoreChannel(session, {
      ...(hasHostRpc
        ? {
            onRequest: (frame) =>
              routeHostRpc(rpc, session, frame, installConnector, () => sessionOpen),
          }
        : {}),
      ...channel,
      stores: rpc.stores,
      log: rpc.log,
    });
  };
}

function routeHostRpc(
  rpc: HostRpcDeps,
  session: HostSession,
  frame: RequestFrame,
  installConnector: (frame: RequestFrame) => void,
  sessionCurrent: () => boolean,
): void {
  if (frame.method === NOTIFICATION_INTENT_METHOD)
    serveNotificationRequest(
      { ...rpc, intents: rpc.notificationIntents, authority: rpc.notificationAuthority },
      session,
      frame,
    );
  else if (frame.method.startsWith("native.connectors.")) installConnector(frame);
  else if (frame.method.startsWith("native.banking."))
    serveBankingRequest({ ...rpc, lock: rpc.server.lock }, session, frame, sessionCurrent);
  else if (frame.method.startsWith("native.pairing."))
    serveNativePairingRequest({
      session,
      frame,
      isStopping: rpc.closing,
      service: rpc.pairing,
      requestSet: rpc.inFlightRequests,
      armIdle: rpc.armIdle,
      handover: rpc.handover,
      log: rpc.log,
    });
  else if (frame.method.startsWith("native.devices.")) serveDevicesRequest(rpc, session, frame);
  else if (frame.method.startsWith("native.relay.")) serveRelayRequest(rpc, session, frame);
  else
    serveNativeCreationRequest({
      session,
      frame,
      creation: rpc.creation,
      isStopping: rpc.closing,
      requestSet: rpc.inFlightRequests,
      armIdle: rpc.armIdle,
      handover: rpc.handover,
      log: rpc.log,
    });
}
