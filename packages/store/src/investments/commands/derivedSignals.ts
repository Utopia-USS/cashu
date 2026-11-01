/** Isolate one optional derived plan pass without changing the caller's successful owner write. */
import { type CommandContext, type CommandResult, refuse } from "../../command.js";
import { PAYLOADS } from "../../events/v1/catalog.js";
import { gid } from "../../events/v1/primitives.js";
import { signalByGid } from "../queries/signals.js";
import { signalPayload } from "./signalReconciliation.js";

const TYPES = ["signal.opened", "signal.refreshed", "signal.escalated", "signal.closed"] as const;
type DerivedType = (typeof TYPES)[number];
interface Draft {
  type: DerivedType;
  gid: string;
  data: Record<string, unknown>;
}
export type StagedSignals<R> =
  | { readonly ok: true; readonly value: R; flush(): void }
  | { readonly ok: false; readonly reason: string };

/**
 * Work and validation cannot leak emits. A failed pass discards all drafts, not the owner's write.
 * Flush only after success and outside the caller's recoverable-derivation catch: a failure while
 * forwarding or appending is a failure of the whole command, never a partially accepted draft set.
 * Reads remain pre-batch; prospective base facts must be supplied explicitly by the caller.
 */
export function stageDerivedSignals<R>(
  ctx: CommandContext,
  work: (child: CommandContext) => CommandResult<R>,
): StagedSignals<R> {
  const drafts: Draft[] = [];
  try {
    const child: CommandContext = {
      ...ctx,
      emit(type, target, data, options) {
        if (!(TYPES as readonly string[]).includes(type) || options?.cause !== undefined)
          throw new TypeError("unsupported derived effect");
        const eventType = type as DerivedType;
        const parsed = PAYLOADS[eventType].safeParse(signalPayload(data));
        if (!gid.safeParse(target).success || !parsed.success)
          throw new TypeError("invalid derived effect");
        if (eventType !== "signal.opened") {
          const signal = signalByGid(ctx.read, target);
          if (
            signal === undefined ||
            (signal.status !== "active" && signal.status !== "acknowledged")
          )
            throw new TypeError("stale derived target");
        }
        drafts.push({ type: eventType, gid: target, data: parsed.data });
        // This event family never uses emit's result. No fabricated cause/eid is forwarded.
        return ctx.newGid();
      },
    };
    const result = work(child);
    if (!result.ok) return result;
    let flushed = false;
    return {
      ok: true,
      value: result.value,
      flush() {
        if (flushed) throw new Error("derived effects already flushed");
        flushed = true;
        for (const draft of drafts) ctx.emit(draft.type, draft.gid, draft.data);
      },
    };
  } catch {
    return refuse("derived_failed");
  }
}
