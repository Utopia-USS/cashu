import {
  type ClientFrame,
  NATIVE_PAIRING_FEATURE,
  pairingCancelParamsSchema,
  pairingCancelResultSchema,
  pairingConfirmParamsSchema,
  pairingConfirmResultSchema,
  pairingInspectParamsSchema,
  pairingInspectResultSchema,
  pairingInviteParamsSchema,
  pairingInviteResultSchema,
  uiPairingAllowed,
} from "@cashu/host-protocol";
import type { JsonValue } from "@cashu/host-protocol/store";
import type { HostSession } from "@cashu/node-host";
import type { HostLog } from "./log.js";
import type { LanPairingService } from "./pairing/service.js";

type Request = Extract<ClientFrame, { t: "req" }>;

export function serveNativePairingRequest(input: {
  readonly session: HostSession;
  readonly frame: Request;
  readonly isStopping: () => boolean;
  readonly currentService: () => LanPairingService | undefined;
  readonly ensureService: () => Promise<LanPairingService | undefined>;
  readonly requestSet: Set<Promise<void>>;
  readonly armIdle: () => void;
  readonly handover: () => void;
  readonly log: HostLog;
}): void {
  const {
    session,
    frame,
    isStopping,
    currentService,
    ensureService,
    requestSet,
    armIdle,
    handover,
    log,
  } = input;
  if (
    isStopping() ||
    !uiPairingAllowed(frame.method, session.protocol.minor, [NATIVE_PAIRING_FEATURE])
  ) {
    session.send({
      t: "res",
      id: frame.id,
      outcome: { ok: false, error: { code: "unknown-method", message: "method unavailable" } },
    });
    return;
  }
  const request = Promise.resolve()
    .then(async () => {
      const service =
        currentService() ??
        (frame.method === "native.pairing.invite" ? await ensureService() : undefined);
      if (service === undefined) {
        session.send({
          t: "res",
          id: frame.id,
          outcome: { ok: true, result: { kind: "refused", code: "unavailable" } },
        });
        return;
      }
      let result: JsonValue;
      let requiresReopen = false;
      switch (frame.method) {
        case "native.pairing.invite": {
          const parsed = pairingInviteParamsSchema.safeParse(frame.params);
          result = parsed.success
            ? pairingInviteResultSchema.parse(await service.invite(parsed.data.vault))
            : { kind: "refused", code: "invalid" };
          break;
        }
        case "native.pairing.confirm": {
          const parsed = pairingConfirmParamsSchema.safeParse(frame.params);
          const outcome = parsed.success
            ? pairingConfirmResultSchema.parse(
                await service.confirm(parsed.data.vault, parsed.data.operationId, parsed.data.code),
              )
            : { kind: "refused" as const, code: "invalid" as const };
          requiresReopen = outcome.kind === "outcome_unknown";
          result = outcome;
          break;
        }
        case "native.pairing.inspect": {
          const parsed = pairingInspectParamsSchema.safeParse(frame.params);
          result = parsed.success
            ? pairingInspectResultSchema.parse(
                await service.inspect(parsed.data.vault, parsed.data.operationId),
              )
            : { kind: "refused", code: "invalid" };
          break;
        }
        case "native.pairing.cancel": {
          const parsed = pairingCancelParamsSchema.safeParse(frame.params);
          result = parsed.success
            ? pairingCancelResultSchema.parse(
                await service.cancel(parsed.data.vault, parsed.data.operationId),
              )
            : { kind: "refused" };
          break;
        }
        default:
          result = { kind: "refused", code: "invalid" };
      }
      try {
        session.send({ t: "res", id: frame.id, outcome: { ok: true, result } });
      } finally {
        if (requiresReopen) setTimeout(handover, 0);
      }
    })
    .catch(() => {
      try {
        session.send({
          t: "res",
          id: frame.id,
          outcome: { ok: false, error: { code: "failed", message: "pairing request failed" } },
        });
      } catch {
        // A disconnected caller has no reply channel.
        log.info("host.pairing.error-reply-disconnected");
      }
    });
  requestSet.add(request);
  void request.finally(() => {
    requestSet.delete(request);
    armIdle();
  });
}
