// The `admin.*` methods of an admin session: status, stop and handover. The reply to stop / handover
// is sent before the host starts stopping (the session then closes with the host).
import {
  type AdminStatus,
  adminHandoverParamsSchema,
  adminStatusParamsSchema,
  adminStopParamsSchema,
} from "@cashu/host-protocol";
import type { HostSession } from "@cashu/node-host";
import type { HostLog } from "./log.js";

export interface AdminHandlers {
  status(): AdminStatus;
  stop(reason: "stop" | "handover"): Promise<number>;
  readonly log: HostLog;
}

export function handleAdmin(session: HostSession, handlers: AdminHandlers): void {
  session.onFrame((frame) => {
    if (frame.t !== "req") return session.close();
    const reply = (result: unknown) =>
      session.send({ t: "res", id: frame.id, outcome: { ok: true, result: result as never } });
    const fail = (code: string, message: string) =>
      session.send({ t: "res", id: frame.id, outcome: { ok: false, error: { code, message } } });
    switch (frame.method) {
      case "admin.status":
        if (!adminStatusParamsSchema.safeParse(frame.params).success) {
          return fail("invalid-params", frame.method);
        }
        return reply(handlers.status());
      case "admin.stop":
        if (!adminStopParamsSchema.safeParse(frame.params).success) {
          return fail("invalid-params", frame.method);
        }
        handlers.log.info("admin.stop");
        reply({ stopping: true });
        void handlers.stop("stop");
        return;
      case "admin.handover":
        if (!adminHandoverParamsSchema.safeParse(frame.params).success) {
          return fail("invalid-params", frame.method);
        }
        handlers.log.info("admin.handover");
        reply({ handover: true });
        void handlers.stop("handover");
        return;
      default:
        return fail("unknown-method", frame.method);
    }
  });
}
