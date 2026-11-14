import { D, parseDateTime } from "@cashu/domain";
import { SignalSeverity } from "@cashu/domain/investments";
import {
  type SignalCandidate,
  SignalPolarity,
  SignalReconciliation,
} from "@cashu/domain/investments/rules";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineCommand, runCommand } from "../../command.js";
import { openSignals } from "../queries/signals.js";
import {
  InvalidSignalPayloadError,
  signalPayload,
  signalReconciliationInput,
} from "./signalReconciliation.js";
import { applySignalActions } from "./signals.js";
import { otherVault, rawGid, vault } from "./testing/fixtures.js";

const at = parseDateTime("2026-10-31T13:00:00.123456+01:00");
const candidate: SignalCandidate = {
  ruleId: "cash",
  kind: "cash_level",
  dedupKey: "cash",
  severity: SignalSeverity.INFO,
  message: "Cash",
  instrumentId: null,
  accountId: null,
  payload: {},
  polarity: SignalPolarity.NEUTRAL,
};

describe("signal lifecycle persistence adapter", () => {
  it("maps every persisted action, keeps microseconds and leaves suppression in stats only", () => {
    const reconciliation = new SignalReconciliation([
      { type: "create", candidate, createdAt: at },
      { type: "refresh", signalId: rawGid(1), candidate, seenAt: at },
      {
        type: "escalate",
        signalId: rawGid(2),
        candidate,
        previousSeverity: SignalSeverity.INFO,
        reactivate: true,
        seenAt: at,
      },
      { type: "resolve", signalId: rawGid(3), ruleId: "cash", dedupKey: "cash", resolvedAt: at },
      {
        type: "expire",
        signalId: rawGid(4),
        ruleId: "cash",
        dedupKey: "cash",
        expiredAt: at,
        reason: "unverified",
      },
      { type: "suppress", candidate, cooldownUntil: at },
    ]);
    const dto = signalReconciliationInput(reconciliation, {
      run: null,
      notify: [SignalSeverity.ACTION],
    });
    expect(dto.actions.map((action) => action.type)).toEqual([
      "create",
      "refresh",
      "escalate",
      "resolve",
      "expire",
    ]);
    expect(dto.actions[0]).toMatchObject({
      createdAt: "2026-10-31T12:00:00.123456Z",
      candidate: { instrument: null, account: null },
    });
    expect(dto.actions[2]).toMatchObject({
      reactivate: true,
      seenAt: "2026-10-31T12:00:00.123456Z",
    });
    expect(dto.actions[4]).toMatchObject({
      reason: "unverified",
      expiredAt: "2026-10-31T12:00:00.123456Z",
    });
    expect(reconciliation.stats.signals_suppressed).toBe(1);
  });

  it("writes decimals as strings and converts nested containers without rewriting dictionaries", () => {
    const dictionary = {
      date: "2026-10-31",
      hour: 1,
      minute: 2,
      second: 3,
      microsecond: 4,
      offsetSeconds: 0,
    };
    const shared = { amount: D("1.50") };
    const payload = {
      nested: [shared, shared],
      values: new Set([D("2.00"), D("3E+1")]),
      dictionary,
    };
    expect(signalPayload(payload)).toEqual({
      nested: [{ amount: "1.50" }, { amount: "1.50" }],
      values: ["2.00", "3E+1"],
      dictionary,
    });
    expect(payload.nested[0]?.amount).toBeInstanceOf(Object);
  });

  it("rejects values JSON.stringify would drop, change or execute", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const getter = Object.defineProperty({}, "value", {
      enumerable: true,
      get() {
        throw new Error("must not execute");
      },
    });
    const toJSON = {
      toJSON() {
        throw new Error("must not execute");
      },
    };
    for (const invalid of [
      undefined,
      () => 1,
      Symbol("x"),
      1n,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      cycle,
      getter,
      toJSON,
      new Date(0),
    ]) {
      expect(() => signalPayload({ nested: [invalid] })).toThrow(InvalidSignalPayloadError);
    }
    expect(() => signalPayload({ nested: { [Symbol("x")]: "value" } })).toThrow(
      InvalidSignalPayloadError,
    );
  });

  it("retains runtime schema validation of numeric keys and timestamps", () => {
    const reconciliation = new SignalReconciliation([
      { type: "create", candidate: { ...candidate, dedupKey: "cash|i:17" }, createdAt: at },
    ]);
    expect(() => signalReconciliationInput(reconciliation, { run: null, notify: [] })).toThrow();
  });

  it("refuses the whole batch for stale or foreign targets after adapting real lifecycle actions", () => {
    const v = vault();
    const other = otherVault();
    const make = (target: typeof v) =>
      target.value(
        applySignalActions,
        signalReconciliationInput(
          new SignalReconciliation([{ type: "create", candidate, createdAt: at }]),
          { run: null, notify: [] },
        ),
      ).created[0] as string;
    const stale = make(v);
    const foreign = make(other);
    v.value(
      applySignalActions,
      signalReconciliationInput(
        new SignalReconciliation([
          { type: "resolve", signalId: stale, ruleId: "cash", dedupKey: "cash", resolvedAt: at },
        ]),
        { run: null, notify: [] },
      ),
    );
    for (const signalId of [stale, foreign]) {
      const reconciliation = new SignalReconciliation([
        { type: "create", candidate, createdAt: at },
        { type: "resolve", signalId, ruleId: "cash", dedupKey: "cash", resolvedAt: at },
      ]);
      let appended = 0;
      const cmd = defineCommand({
        id: "test.applyAdaptedSignals",
        input: z.object({}),
        run(ctx) {
          return applySignalActions.run(
            ctx,
            signalReconciliationInput(reconciliation, { run: null, notify: [] }),
          );
        },
      });
      expect(
        runCommand(
          v.store,
          {
            append(events) {
              appended += 1;
              v.store.applyEnvelopes(events);
            },
          },
          cmd,
          {},
          v.env,
        ),
      ).toEqual({ ok: false, reason: "not_open" });
      expect(appended).toBe(0);
      expect(openSignals(v.store.read.bind(v.store))).toEqual([]);
    }
    expect(openSignals(other.store.read.bind(other.store))).toHaveLength(1);
  });
});
