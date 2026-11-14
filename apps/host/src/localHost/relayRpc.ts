// `native.relay.*`: the sync relay of one vault (relay/service.ts). `status` reads; `enable`, `disable`
// and `purge` are owner actions from Settings. A switch that changed the vault's engine remotes reopens
// the vaults through the handover after the reply (the engine reads its remotes once at open), also
// when a purge is refused after it already turned the switch off.
import {
  NATIVE_RELAY_FEATURE,
  type RelayActionResult,
  relayActionParamsSchema,
  relayActionResultSchema,
  relayStatusParamsSchema,
  relayStatusResultSchema,
  uiRelayAllowed,
} from "@cashu/host-protocol";
import type { HostSession } from "@cashu/node-host";
import type { HostRelay, RelayOutcome } from "../relay/service.js";
import {
  type RequestFrame,
  type RequestScope,
  refuseUnavailableMethod,
  serveTrackedRequest,
} from "./requests.js";

type RelayScope = RequestScope & {
  readonly nativeMode: boolean;
  readonly relay: HostRelay;
  /** Schedules the handover that reopens the vaults. */
  readonly handoverSoon: () => void;
};

/**
 * Invalid params (a client of another build) answer `busy` and status a hidden row: the fixed result
 * shapes have no `invalid_input`, and neither case can come from the desktop of this build.
 */
const BUSY: RelayActionResult = { kind: "refused", reason: "busy" };

export function serveRelayRequest(
  scope: RelayScope,
  session: HostSession,
  frame: RequestFrame,
): void {
  if (
    !scope.nativeMode ||
    scope.closing() ||
    !uiRelayAllowed(frame.method, session.protocol.minor, [NATIVE_RELAY_FEATURE])
  ) {
    refuseUnavailableMethod(session, frame);
    return;
  }
  const { relay } = scope;
  if (frame.method === "native.relay.status") {
    const parsed = relayStatusParamsSchema.safeParse(frame.params);
    serveTrackedRequest(
      scope,
      session,
      frame,
      async () => ({
        result: relayStatusResultSchema.parse(
          parsed.success
            ? relay.status(parsed.data.vault)
            : { configured: relay.configured, enabled: false, status: {}, devices: 0 },
        ),
      }),
      { configured: relay.configured, enabled: false, status: {}, devices: 0 },
    );
    return;
  }
  const action: ((vault: string) => Promise<RelayOutcome>) | undefined =
    frame.method === "native.relay.enable"
      ? (vault) => relay.enable(vault)
      : frame.method === "native.relay.disable"
        ? (vault) => relay.disable(vault)
        : frame.method === "native.relay.purge"
          ? (vault) => relay.purge(vault)
          : undefined;
  const parsed = relayActionParamsSchema.safeParse(frame.params);
  serveTrackedRequest(
    scope,
    session,
    frame,
    async () => {
      if (action === undefined || !parsed.success) return { result: BUSY };
      const { result, reopen } = await action(parsed.data.vault);
      const checked = relayActionResultSchema.parse(result);
      return reopen ? { result: checked, afterSend: scope.handoverSoon } : { result: checked };
    },
    BUSY,
  );
}
