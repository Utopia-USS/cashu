// The command framework (S24 5): input validation, one batch per command with strictly increasing
// HLCs above everything folded, catalog + DET validation of every emitted event, refusals emit
// nothing. Synthetic data only.

import { compareHlc } from "@cashu/sync/hlc";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  defineCommand,
  InvalidEmitError,
  ok,
  prepareCommand,
  refuse,
  runCommand,
} from "./command.js";
import { toUnstampedEvent } from "./command-durable.js";
import type { Envelope } from "./events/v1/envelope.js";
import { run, testEnv } from "./testing/commands.js";
import { EventFactory, openTestStore } from "./testing/store.js";

const setRules = defineCommand({
  id: "test.setRules",
  input: z.object({ keys: z.array(z.string().min(1)), refuseIf: z.string().optional() }),
  run(ctx, input) {
    if (input.refuseIf !== undefined && input.keys.includes(input.refuseIf)) {
      ctx.emit("categoryRule.set", ctx.det("category_rules", ["X"]), {
        merchantKey: "X",
        category: "other",
        source: "manual",
        locked: true,
      });
      return refuse("not_allowed");
    }
    for (const k of input.keys) {
      ctx.emit("categoryRule.set", ctx.det("category_rules", [k]), {
        merchantKey: k,
        category: "groceries",
        source: "manual",
        locked: true,
      });
    }
    return ok(input.keys.length);
  },
});

describe("commands", () => {
  it("prepares the same ordered EIDs and payloads without ticking the durable clock", () => {
    const legacy = runCommand(
      openTestStore(),
      { append() {} },
      setRules,
      { keys: ["A", "B"] },
      testEnv(),
    );
    const env = testEnv();
    const before = env.hlc.last;
    const prepared = prepareCommand(openTestStore(), setRules, { keys: ["A", "B"] }, env);
    expect(prepared.ok).toBe(true);
    if (!legacy.ok || !prepared.ok) return;
    expect(env.hlc.last).toBe(before);
    expect(prepared.events.map((event) => event.eid)).toEqual(
      legacy.events.map((event) => event.eid),
    );
    expect(prepared.events.map((event) => event.data)).toEqual(
      legacy.events.map((event) => event.data),
    );
    expect(prepared.events.map(toUnstampedEvent).map((event) => event.i)).toEqual(
      legacy.events.map((event) => event.eid),
    );
    expect(prepared.events.every((event) => !("hlc" in event))).toBe(true);
  });

  it("detaches and freezes a prepared payload before returning", () => {
    const store = openTestStore();
    const payload = { merchantKey: "A", category: "groceries", source: "manual", locked: true };
    const command = defineCommand({
      id: "test.mutablePayload",
      input: z.object({}),
      run(ctx) {
        ctx.emit("categoryRule.set", ctx.det("category_rules", ["A"]), payload);
        return ok(null);
      },
    });
    const prepared = prepareCommand(store, command, {}, testEnv());
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    payload.category = "fuel";
    expect(prepared.events[0]?.data.category).toBe("groceries");
    expect(Object.isFrozen(prepared.events[0]?.data)).toBe(true);
    expect(
      toUnstampedEvent(prepared.events[0] as (typeof prepared.events)[number]).d.category,
    ).toBe("groceries");
    expect(() =>
      toUnstampedEvent({ ...prepared.events[0] } as (typeof prepared.events)[number]),
    ).toThrow(InvalidEmitError);
  });

  it("emit one batch with increasing HLCs, validated and applied", () => {
    const store = openTestStore();
    const env = testEnv();
    const out = run(store, env, setRules, { keys: ["A", "B", "C"] });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value).toBe(3);
    const hlcs = out.events.map((e) => e.hlc);
    for (let i = 1; i < hlcs.length; i++) {
      expect(compareHlc(hlcs[i - 1] as string, hlcs[i] as string)).toBeLessThan(0);
    }
    expect(new Set(out.events.map((e) => e.eid)).size).toBe(3);
    expect(store.read("SELECT merchant_key FROM category_rules ORDER BY merchant_key")).toEqual([
      { merchant_key: "A" },
      { merchant_key: "B" },
      { merchant_key: "C" },
    ]);
  });

  it("refuse invalid input and expected failures without appending", () => {
    const store = openTestStore();
    const appended: Envelope[][] = [];
    const writer = { append: (b: readonly Envelope[]) => void appended.push([...b]) };
    expect(runCommand(store, writer, setRules, { keys: [1] }, testEnv())).toEqual({
      ok: false,
      reason: "invalid_input",
    });
    expect(runCommand(store, writer, setRules, { keys: ["A"], refuseIf: "A" }, testEnv())).toEqual({
      ok: false,
      reason: "not_allowed",
    });
    expect(appended).toEqual([]);
  });

  it("stamp above every folded event, even one from a clock ahead of this device", () => {
    const store = openTestStore();
    const f = new EventFactory("dddddddddddddddddddddddddddddddd");
    const ahead = f.make(
      "categoryRule.set",
      store.deps.det("category_rules", ["Z"]),
      { merchantKey: "Z", category: "fuel", source: "manual", locked: false },
      { wall: 60_000 },
    );
    store.applyEnvelopes([ahead]);
    const out = run(store, testEnv(), setRules, { keys: ["Z"] });
    expect(out.ok && compareHlc(ahead.hlc, out.events[0]?.hlc as string)).toBeLessThan(0);
    expect(store.read("SELECT category FROM category_rules")).toEqual([{ category: "groceries" }]);
  });

  it("throw on an emitted event the catalog would park or whose DET gid does not match", () => {
    const store = openTestStore();
    const badGid = defineCommand({
      id: "test.badGid",
      input: z.object({}),
      run(ctx) {
        ctx.emit("categoryRule.set", ctx.det("category_rules", ["A"]), {
          merchantKey: "B",
          category: "fuel",
          source: "manual",
          locked: false,
        });
        return ok(null);
      },
    });
    const badPayload = defineCommand({
      id: "test.badPayload",
      input: z.object({}),
      run(ctx) {
        ctx.emit("categoryRule.set", ctx.det("category_rules", ["A"]), { merchantKey: "A" });
        return ok(null);
      },
    });
    expect(() => run(store, testEnv(), badGid, {})).toThrow(InvalidEmitError);
    expect(() => run(store, testEnv(), badPayload, {})).toThrow(InvalidEmitError);
    expect(store.read("SELECT COUNT(*) AS n FROM event_log")).toEqual([{ n: 0 }]);
  });
});
