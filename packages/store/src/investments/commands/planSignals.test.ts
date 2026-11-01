import { D, parseDateTime, toCurrency, toStorage } from "@cashu/domain";
import {
  asInstrumentId,
  asProfileId,
  buildSnapshot,
  InMemoryFxLookup,
  marketView,
  priceBar,
  valuePortfolio,
} from "@cashu/domain/investments";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type CommandContext, defineCommand, ok, storeWriter } from "../../command.js";
import { loadInstruments, overrides } from "../queries/instruments.js";
import { openSignals } from "../queries/signals.js";
import { transactions } from "../queries/transactions.js";
import { writePlan } from "../services/plans.js";
import { stageDerivedSignals } from "./derivedSignals.js";
import { setInstrumentPlan } from "./instruments.js";
import { addManualTransaction } from "./manual.js";
import { applyPlanChecks } from "./planSignals.js";
import { applySignalActions } from "./signals.js";
import { applyRaw, brokerage, otherVault, raw, rawGid, stock, vault } from "./testing/fixtures.js";

function setup() {
  const v = vault();
  const account = brokerage(v);
  const instrument = stock(v, "AAA", "PL0000000AAA");
  applyRaw(v, [raw.watchAdded(v, instrument)]);
  v.value(addManualTransaction, {
    account,
    type: "deposit",
    tradeDate: "2026-10-30",
    cashAmount: "100",
  });
  v.value(addManualTransaction, {
    account,
    instrument,
    type: "buy",
    tradeDate: "2026-10-30",
    quantity: "10",
    price: "10",
  });
  const buildValued = (read: CommandContext["read"]) => {
    const instruments = new Map(
      [...loadInstruments(read, [instrument]).values()].map((inst) => [inst.id, inst]),
    );
    const id = asInstrumentId(instrument);
    const asOf = "2026-10-31";
    return valuePortfolio(
      buildSnapshot(asProfileId(v.store.vault), transactions(read), asOf),
      marketView({
        asOf,
        instruments,
        bars: new Map([
          [id, [priceBar({ instrumentId: id, date: asOf, close: D("20"), source: "synthetic" })]],
        ]),
      }),
      new InMemoryFxLookup([]),
      toCurrency("PLN"),
      5,
    );
  };
  const read = v.store.read.bind(v.store);
  return { v, instrument, buildValued, read };
}

describe("plan signals and immediate recommendation writes", () => {
  it("observes the pending normalized recommendation and emits one batch with actual stored facts/valuation", () => {
    const { v, instrument, buildValued, read } = setup();
    let batches = 0;
    const writer = {
      append(events: Parameters<ReturnType<typeof storeWriter>["append"]>[0]) {
        batches += 1;
        v.store.applyEnvelopes(events);
      },
    };
    let pendingAt = "";
    const deps = {
      store: v.store,
      writer,
      env: v.env,
      immediate: {
        buildValued(read: CommandContext["read"], now: Parameters<typeof toStorage>[0]) {
          pendingAt = toStorage(now);
          return buildValued(read);
        },
        config: null,
        lang: "en" as const,
      },
    };
    const first = writePlan(deps, { instrument, plan: "hold", today: "2026-10-31" });
    expect(first.ok).toBe(true);
    expect(batches).toBe(1);
    expect(first.ok && first.events.map((event) => event.type)).toEqual([
      "instrumentOverride.planSet",
      "signal.opened",
    ]);
    expect(openSignals(read)[0]).toMatchObject({
      dedupKey: `plan:plan_no_exit|i:${instrument}`,
      payload: { plan: "hold", unrealized: 1 },
    });
    expect(openSignals(read)[0]?.message).toBe("+100% from cost, no exit plan");
    expect(overrides(read).get(instrument)?.planAt).toBe(pendingAt);
    const reduce = writePlan(deps, { instrument, plan: "reduce", today: "2026-10-31" });
    expect(reduce.ok && reduce.events.map((event) => event.type)).toEqual([
      "instrumentOverride.planSet",
      "signal.closed",
    ]);
    expect(openSignals(read)).toEqual([]);
    expect(overrides(read).get(instrument)?.plan).toBe("reduce");
    const polish = writePlan(
      { ...deps, immediate: { ...deps.immediate, lang: "pl" } },
      { instrument, plan: "hold", today: "2026-10-31" },
    );
    expect(polish.ok).toBe(true);
    expect(openSignals(read)[0]?.message).toBe("+100 % od kosztu, brak planu wyjścia");
  });

  it("preserves base writes when deriving facts fails or the device is not leader", () => {
    const { v, instrument, read } = setup();
    let builds = 0;
    const deps = {
      store: v.store,
      writer: storeWriter(v.store),
      env: v.env,
      immediate: {
        config: null,
        lang: "en" as const,
        buildValued() {
          builds += 1;
          throw new Error("synthetic derivation failure");
        },
      },
    };
    expect(writePlan(deps, { instrument, plan: "hold", today: "2026-10-31" }).ok).toBe(true);
    expect(overrides(read).get(instrument)?.plan).toBe("hold");
    expect(builds).toBe(1);
    v.env.holder = false;
    expect(writePlan(deps, { instrument, plan: "buy", today: "2026-10-31" }).ok).toBe(true);
    expect(overrides(read).get(instrument)?.plan).toBe("buy");
    expect(builds).toBe(1);
    expect(openSignals(read)).toEqual([]);
  });

  it("treats final append failure as failure of the whole command, not a recoverable derived pass", () => {
    const { v, instrument, buildValued, read } = setup();
    let appends = 0;
    expect(() =>
      writePlan(
        {
          store: v.store,
          env: v.env,
          writer: {
            append() {
              appends += 1;
              throw new Error("synthetic append failure");
            },
          },
          immediate: { buildValued, config: null, lang: "en" },
        },
        { instrument, plan: "hold", today: "2026-10-31" },
      ),
    ).toThrow("synthetic append failure");
    expect(appends).toBe(1);
    expect(overrides(read).get(instrument)?.plan).toBeUndefined();
    expect(openSignals(read)).toEqual([]);
  });

  it("discards every derived draft on a late target refusal while preserving the base event", () => {
    const { v, instrument, read } = setup();
    const command = defineCommand({
      id: "test.planSavepoint",
      input: z.object({}),
      run(ctx) {
        const base = setInstrumentPlan.run(
          ctx,
          setInstrumentPlan.input.parse({ instrument, plan: "hold", held: true }),
        );
        if (!base.ok) return base;
        const staged = stageDerivedSignals(ctx, (child) =>
          applySignalActions.run(
            child,
            applySignalActions.input.parse({
              run: null,
              actions: [
                {
                  type: "create",
                  createdAt: ctx.now(),
                  candidate: {
                    ruleId: "plan:test",
                    kind: "plan:test",
                    dedupKey: `plan:test|i:${instrument}`,
                    instrument,
                    severity: "info",
                    message: "Synthetic",
                    polarity: "negative",
                    payload: {},
                  },
                },
                { type: "resolve", signal: rawGid(99), resolvedAt: ctx.now() },
              ],
            }),
          ),
        );
        expect(staged.ok).toBe(false);
        if (staged.ok) staged.flush();
        return base;
      },
    });
    const result = v.run(command, {});
    expect(result.ok && result.events.map((event) => event.type)).toEqual([
      "instrumentOverride.planSet",
    ]);
    expect(overrides(read).get(instrument)?.plan).toBe("hold");
    expect(openSignals(read)).toEqual([]);
  });

  it("rejects unsupported event kinds/causes and invalid final drafts without forwarding earlier effects", () => {
    const { v, instrument, read } = setup();
    for (const failure of ["kind", "cause", "payload"]) {
      const command = defineCommand({
        id: "test.stagePlanEffects",
        input: z.object({}),
        run(ctx) {
          const base = setInstrumentPlan.run(
            ctx,
            setInstrumentPlan.input.parse({ instrument, plan: "hold", held: true }),
          );
          if (!base.ok) return base;
          const staged = stageDerivedSignals(ctx, (child) => {
            child.emit("signal.opened", child.newGid(), {
              ruleId: "plan:test",
              kind: "plan:test",
              dedupKey: "plan:test",
              severity: "info",
              polarity: "negative",
              message: "Synthetic",
              instrument: null,
              account: null,
              payload: {},
              run: null,
            });
            if (failure === "kind") child.emit("alert.deleted", child.newGid(), {});
            else if (failure === "cause")
              child.emit("signal.closed", child.newGid(), {}, { cause: rawGid(77) });
            else child.emit("signal.opened", child.newGid(), { payload: { missing: undefined } });
            return ok({});
          });
          expect(staged.ok).toBe(false);
          if (staged.ok) staged.flush();
          return base;
        },
      });
      const result = v.run(command, {});
      expect(result.ok && result.events.map((event) => event.type)).toEqual([
        "instrumentOverride.planSet",
      ]);
    }
    expect(openSignals(read)).toEqual([]);
  });

  it("scoped checks never expire unrelated plan episodes and daily checks resolve sold scopes", () => {
    const { v, instrument, read } = setup();
    const second = stock(v, "BBB", "PL0000000BBB");
    applyRaw(v, [raw.watchAdded(v, second)]);
    const execute = (only?: string, held = true) =>
      v.run(
        defineCommand({
          id: "test.planPass",
          input: z.object({}),
          run(ctx) {
            return applyPlanChecks(ctx, {
              now: parseDateTime(ctx.now()),
              run: null,
              config: null,
              lang: "en",
              ...(only === undefined ? {} : { only: asInstrumentId(only) }),
              facts: held
                ? [
                    {
                      instrumentId: asInstrumentId(instrument),
                      label: "AAA",
                      plan: null,
                      health: "fulfilled",
                      hasExitPlan: false,
                      unrealized: null,
                      priceStale: true,
                    },
                  ]
                : [],
            });
          },
        }),
        {},
      );
    expect(execute(instrument).ok).toBe(true);
    expect(execute(second, false).ok).toBe(true);
    expect(openSignals(read)).toHaveLength(1);
    const daily = execute(undefined, false);
    expect(daily.ok).toBe(true);
    expect(openSignals(read)).toEqual([]);
    const other = otherVault();
    expect(
      other.run(
        defineCommand({
          id: "test.foreignPlanPass",
          input: z.object({}),
          run(ctx) {
            return applyPlanChecks(ctx, {
              now: parseDateTime(ctx.now()),
              run: null,
              config: null,
              lang: "en",
              only: asInstrumentId(instrument),
              facts: [],
            });
          },
        }),
        {},
      ),
    ).toEqual({ ok: false, reason: "invalid_identity" });
  });
});
