// `native.devices.*`: list devices, revoke one (preview / commit / inspect / cancel) and move the
// sync leader (preview / commit / inspect). Each method parses its params, calls the device service
// and validates the result; invalid params are refused, a commit whose outcome is unknown reopens
// the host (handover) after the reply.
import {
  deviceListParamsSchema,
  deviceListResultSchema,
  leaderCommitParamsSchema,
  leaderCommitResultSchema,
  leaderInspectParamsSchema,
  leaderInspectResultSchema,
  leaderPreviewParamsSchema,
  leaderPreviewResultSchema,
  NATIVE_DEVICES_FEATURE,
  revokeCancelParamsSchema,
  revokeCancelResultSchema,
  revokeCommitParamsSchema,
  revokeCommitResultSchema,
  revokeInspectParamsSchema,
  revokeInspectResultSchema,
  revokePreviewParamsSchema,
  revokePreviewResultSchema,
  uiDevicesAllowed,
} from "@cashu/host-protocol";
import type { JsonValue } from "@cashu/host-protocol/store";
import type { HostSession } from "@cashu/node-host";
import type { DeviceService } from "../devices/service.js";
import {
  type RequestFrame,
  type RequestScope,
  refuseUnavailableMethod,
  serveTrackedRequest,
} from "./requests.js";

const INVALID_INPUT = { kind: "refused", code: "invalid_input" } as const;
const UNAVAILABLE = { kind: "refused", code: "unavailable" } as const;

interface DeviceReply {
  readonly result: JsonValue;
  /** The commit's outcome is unknown: the host reopens its vaults (handover). */
  readonly reopen: boolean;
}

type DeviceMethod = (devices: DeviceService, params: unknown) => Promise<DeviceReply>;

interface ParamsSchema<P> {
  safeParse(value: unknown): { success: true; data: P } | { success: false };
}

function method<P, R extends JsonValue & { readonly kind: string }>(
  params: ParamsSchema<P>,
  result: { parse(value: unknown): R },
  call: (devices: DeviceService, input: P) => Promise<unknown>,
  options: { readonly reopenOnUnknownOutcome?: boolean } = {},
): DeviceMethod {
  return async (devices, raw) => {
    const input = params.safeParse(raw);
    if (!input.success) return { result: INVALID_INPUT, reopen: false };
    const parsed = result.parse(await call(devices, input.data));
    return {
      result: parsed,
      reopen: options.reopenOnUnknownOutcome === true && parsed.kind === "outcome_unknown",
    };
  };
}

const DEVICE_METHODS: ReadonlyMap<string, DeviceMethod> = new Map([
  [
    "native.devices.list",
    method(deviceListParamsSchema, deviceListResultSchema, (d, input) => d.list(input)),
  ],
  [
    "native.devices.revokePreview",
    method(revokePreviewParamsSchema, revokePreviewResultSchema, (d, input) => d.preview(input)),
  ],
  [
    "native.devices.revokeCommit",
    method(revokeCommitParamsSchema, revokeCommitResultSchema, (d, input) => d.commit(input), {
      reopenOnUnknownOutcome: true,
    }),
  ],
  [
    "native.devices.revokeInspect",
    method(revokeInspectParamsSchema, revokeInspectResultSchema, (d, input) => d.inspect(input)),
  ],
  [
    "native.devices.revokeCancel",
    method(revokeCancelParamsSchema, revokeCancelResultSchema, (d, input) => d.cancel(input)),
  ],
  [
    "native.devices.leaderPreview",
    method(leaderPreviewParamsSchema, leaderPreviewResultSchema, (d, input) =>
      d.leaderPreview(input),
    ),
  ],
  [
    "native.devices.leaderCommit",
    method(
      leaderCommitParamsSchema,
      leaderCommitResultSchema,
      (d, input) => d.leaderCommit(input),
      { reopenOnUnknownOutcome: true },
    ),
  ],
  [
    "native.devices.leaderInspect",
    method(leaderInspectParamsSchema, leaderInspectResultSchema, (d, input) =>
      d.leaderInspect(input),
    ),
  ],
]);

export function serveDevicesRequest(
  scope: RequestScope & {
    readonly nativeMode: boolean;
    readonly devices: DeviceService;
    /** Schedules the handover that reopens the vaults after an unknown commit outcome. */
    readonly handoverSoon: () => void;
  },
  session: HostSession,
  frame: RequestFrame,
): void {
  if (
    !scope.nativeMode ||
    scope.closing() ||
    !uiDevicesAllowed(frame.method, session.protocol.minor, [NATIVE_DEVICES_FEATURE])
  ) {
    refuseUnavailableMethod(session, frame);
    return;
  }
  serveTrackedRequest(
    scope,
    session,
    frame,
    async () => {
      const handler = DEVICE_METHODS.get(frame.method);
      const { result, reopen } =
        handler === undefined
          ? { result: INVALID_INPUT, reopen: false }
          : await handler(scope.devices, frame.params);
      return reopen ? { result, afterSend: scope.handoverSoon } : { result };
    },
    UNAVAILABLE,
  );
}
