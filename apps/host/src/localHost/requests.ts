// Shared scaffolding of the UI-role host RPCs the host answers itself (devices, notification,
// banking; creation and pairing live in nativeCreationRpc.ts / pairingRpc.ts with the same shape):
// refuse an unavailable method, otherwise compute the reply off the frame handler, send it, answer a
// fixed fallback when anything throws, and track the request until it settled.
import type { ClientFrame } from "@cashu/host-protocol";
import type { JsonValue } from "@cashu/host-protocol/store";
import type { HostSession } from "@cashu/node-host";

export type RequestFrame = Extract<ClientFrame, { t: "req" }>;

/** What every host RPC handler needs from the host's lifecycle. */
export interface RequestScope {
  /** In-flight host RPCs: an idle host waits for them, a stopping host settles them. */
  readonly inFlightRequests: Set<Promise<void>>;
  readonly armIdle: () => void;
  /** No new host work: the server is stopping, a stop began or the bundle was replaced. */
  readonly closing: () => boolean;
}

interface Reply {
  readonly result: JsonValue;
  /** Runs after the reply was sent (or sending threw). */
  readonly afterSend?: () => void;
}

/** Answers a method this host does not serve (feature off, older protocol, stopping). */
export function refuseUnavailableMethod(session: HostSession, frame: RequestFrame): void {
  session.send({
    t: "res",
    id: frame.id,
    outcome: { ok: false, error: { code: "unknown-method", message: "method unavailable" } },
  });
}

/**
 * Serves one request off the frame handler: sends `reply()`'s result, or `fallback` when computing
 * or sending it threw (a disconnected caller gets nothing). Tracked in `inFlightRequests` until it
 * settled, then re-arms the idle timer.
 */
export function serveTrackedRequest(
  scope: RequestScope,
  session: HostSession,
  frame: RequestFrame,
  reply: () => Promise<Reply>,
  fallback: JsonValue,
): void {
  const request = Promise.resolve()
    .then(async () => {
      const { result, afterSend } = await reply();
      try {
        session.send({ t: "res", id: frame.id, outcome: { ok: true, result } });
      } finally {
        afterSend?.();
      }
    })
    .catch(() => {
      try {
        session.send({ t: "res", id: frame.id, outcome: { ok: true, result: fallback } });
      } catch {
        /* caller disconnected; never a token-bearing error */
      }
    })
    .finally(() => {
      scope.inFlightRequests.delete(request);
      scope.armIdle();
    });
  scope.inFlightRequests.add(request);
}
