/** Pure lifecycle actions translated into the existing validated event-command DTO. */
import { type DateTime, Decimal, formatDateTime, toUtc } from "@cashu/domain";
import type { SignalSeverity } from "@cashu/domain/investments";
import type { SignalCandidate, SignalReconciliation } from "@cashu/domain/investments/rules";
import { applySignalActions, type SignalActionsInput } from "./signals.js";

/** A payload cannot be persisted without changing or losing one of its values. */
export class InvalidSignalPayloadError extends TypeError {
  constructor() {
    super("signal payload is not JSON-encodable");
    this.name = "InvalidSignalPayloadError";
  }
}

/**
 * Python store/signals.py `_jsonable`: preserve JSON values, stringify Decimal, and turn
 * supported collections into arrays. Plain date-shaped dictionaries remain dictionaries.
 * Reject JavaScript-only values rather than let JSON.stringify silently discard them.
 */
export function signalPayload(payload: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const ancestors = new Set<object>();
  const visit = (value: unknown): unknown => {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new InvalidSignalPayloadError();
      return value;
    }
    if (value instanceof Decimal) return value.toString();
    if (typeof value !== "object") throw new InvalidSignalPayloadError();
    if (ancestors.has(value)) throw new InvalidSignalPayloadError();
    ancestors.add(value);
    try {
      if (Array.isArray(value)) return Array.from(value, visit);
      // `_jsonable` explicitly accepts Python set/frozenset in addition to list/tuple.
      if (value instanceof Set) return Array.from(value, visit);
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null)
        throw new InvalidSignalPayloadError();
      const out: Record<string, unknown> = {};
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== "string") throw new InvalidSignalPayloadError();
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable) continue;
        if (!("value" in descriptor)) throw new InvalidSignalPayloadError();
        Object.defineProperty(out, key, {
          value: visit(descriptor.value),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return out;
    } finally {
      ancestors.delete(value);
    }
  };
  return visit(payload) as Record<string, unknown>;
}

const eventTime = (at: DateTime): string => formatDateTime(toUtc(at)).replace(/\+00:00$/, "Z");

function candidateInput(candidate: SignalCandidate) {
  return {
    ruleId: candidate.ruleId,
    kind: candidate.kind,
    dedupKey: candidate.dedupKey,
    severity: candidate.severity,
    message: candidate.message,
    instrument: candidate.instrumentId,
    account: candidate.accountId,
    payload: signalPayload(candidate.payload),
    polarity: candidate.polarity,
  };
}

/** Suppression remains in reconciliation statistics and never allocates a persisted signal. */
export function signalReconciliationInput(
  reconciliation: SignalReconciliation<string>,
  options: { readonly run: string | null; readonly notify: readonly SignalSeverity[] },
): SignalActionsInput {
  const actions = reconciliation.actions.flatMap<SignalActionsInput["actions"][number]>(
    (action) => {
      switch (action.type) {
        case "suppress":
          return [];
        case "create":
          return [
            {
              type: "create",
              candidate: candidateInput(action.candidate),
              createdAt: eventTime(action.createdAt),
            },
          ];
        case "refresh":
          return [
            {
              type: "refresh",
              signal: action.signalId,
              candidate: candidateInput(action.candidate),
              seenAt: eventTime(action.seenAt),
            },
          ];
        case "escalate":
          return [
            {
              type: "escalate",
              signal: action.signalId,
              candidate: candidateInput(action.candidate),
              seenAt: eventTime(action.seenAt),
              reactivate: action.reactivate,
            },
          ];
        case "resolve":
          return [
            { type: "resolve", signal: action.signalId, resolvedAt: eventTime(action.resolvedAt) },
          ];
        case "expire":
          return [
            {
              type: "expire",
              signal: action.signalId,
              expiredAt: eventTime(action.expiredAt),
              reason: action.reason,
            },
          ];
      }
      throw new TypeError("unknown signal lifecycle action");
    },
  );
  return applySignalActions.input.parse({ actions, run: options.run, notify: [...options.notify] });
}
