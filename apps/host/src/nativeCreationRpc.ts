import {
  type ClientFrame,
  NATIVE_CREATION_FEATURE,
  nativeCreationCommitParamsSchema,
  nativeCreationCommitResultSchema,
  nativeCreationCurrentParamsSchema,
  nativeCreationCurrentResultSchema,
  nativeCreationInspectParamsSchema,
  nativeCreationInspectResultSchema,
  nativeCreationPrepareParamsSchema,
  nativeCreationPrepareResultSchema,
  uiCreationAllowed,
} from "@cashu/host-protocol";
import type { JsonValue } from "@cashu/host-protocol/store";
import type { HostSession } from "@cashu/node-host";
import type { HostLog } from "./log.js";
import type { createNativeCreationService } from "./nativeCreation.js";

type Request = Extract<ClientFrame, { t: "req" }>;
type Creation = ReturnType<typeof createNativeCreationService>;

export function serveNativeCreationRequest(input: {
  readonly session: HostSession;
  readonly frame: Request;
  readonly creation: Creation | undefined;
  readonly isStopping: () => boolean;
  readonly requestSet: Set<Promise<void>>;
  readonly armIdle: () => void;
  readonly handover: () => void;
  readonly log: HostLog;
}): void {
  const { session, frame, creation, isStopping, requestSet, armIdle, handover, log } = input;
  // Close admission before shutdown snapshots in-flight requests and releases HostLock.
  if (isStopping()) {
    session.send({
      t: "res",
      id: frame.id,
      outcome: { ok: false, error: { code: "stopping", message: "host is stopping" } },
    });
    return;
  }
  if (
    creation === undefined ||
    !uiCreationAllowed(frame.method, session.protocol.minor, [NATIVE_CREATION_FEATURE])
  ) {
    session.send({
      t: "res",
      id: frame.id,
      outcome: { ok: false, error: { code: "unknown-method", message: "method unavailable" } },
    });
    return;
  }
  let verifiedReady = false;
  const request = Promise.resolve()
    .then(async () => {
      let result: JsonValue;
      switch (frame.method) {
        case "native.creation.prepare": {
          const parsed = nativeCreationPrepareParamsSchema.safeParse(frame.params);
          result = parsed.success
            ? nativeCreationPrepareResultSchema.parse(await creation.prepare(parsed.data))
            : { kind: "refused", code: "invalid_input" };
          break;
        }
        case "native.creation.commit": {
          const parsed = nativeCreationCommitParamsSchema.safeParse(frame.params);
          const outcome = parsed.success
            ? nativeCreationCommitResultSchema.parse(await creation.commit(parsed.data))
            : { kind: "refused" as const, code: "invalid_input" as const };
          verifiedReady = outcome.kind === "ready";
          result = outcome;
          break;
        }
        case "native.creation.inspect":
          result = nativeCreationInspectResultSchema.parse(
            await creation.inspect(nativeCreationInspectParamsSchema.parse(frame.params)),
          );
          break;
        case "native.creation.current":
          result = nativeCreationCurrentResultSchema.parse(
            await creation.current(nativeCreationCurrentParamsSchema.parse(frame.params)),
          );
          break;
        default:
          throw new Error("unknown_method");
      }
      try {
        session.send({ t: "res", id: frame.id, outcome: { ok: true, result } });
      } catch {
        // A disconnected caller reconciles with read-only inspect/current.
        log.info("host.creation.reply-disconnected");
      }
      if (verifiedReady) setTimeout(handover, 0);
    })
    .catch(() => {
      try {
        session.send({
          t: "res",
          id: frame.id,
          outcome: { ok: false, error: { code: "failed", message: "creation request failed" } },
        });
      } catch {
        // The client may already be gone.
        log.info("host.creation.error-reply-disconnected");
      }
    })
    .finally(() => {
      requestSet.delete(request);
      armIdle();
    });
  requestSet.add(request);
}
