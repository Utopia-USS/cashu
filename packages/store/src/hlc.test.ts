// The sync engine's stuck records (D7) in a vault's `store_meta`: one JSON value per device, read back
// as written, and read as none when the stored value does not decode. Synthetic values only.
import { describe, expect, it } from "vitest";
import { metaGateStateStore } from "./hlc.js";
import { openTestStore } from "./testing/store.js";

const A = "daaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "dbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const C = "dccccccccccccccccccccccccccccccc";

const record = (device: string, over: Record<string, unknown> = {}) => ({
  device,
  seg: 3,
  offset: 4096,
  code: "unknown_key",
  kind: "waiting",
  firstSeenAt: 1_793_448_000_000,
  passes: 2,
  ...over,
});

describe("metaGateStateStore stuck records", () => {
  it("round-trips the engine's text per device, across a view reset, apart from the evidence", () => {
    const s = openTestStore();
    try {
      const gate = metaGateStateStore(s.driver, A);
      expect(gate.loadStuck()).toBeUndefined();
      const text = JSON.stringify([record(B), record(C, { kind: "final", code: "forked" })]);
      gate.saveStuck(text);
      expect(gate.loadStuck()).toBe(text);
      gate.appendEvidence(["p1"]);
      s.reset();
      const again = metaGateStateStore(s.driver, A);
      expect(again.loadStuck()).toBe(text);
      expect(again.loadEvidence()).toEqual(["p1"]);
      expect(again.load()).toBeUndefined();
      expect(metaGateStateStore(s.driver, B).loadStuck()).toBeUndefined();
      // replaced, never appended; an empty list is a valid value (nothing stuck any more)
      again.saveStuck("[]");
      expect(metaGateStateStore(s.driver, A).loadStuck()).toBe("[]");
      expect(
        s.read<{ n: number }>("SELECT count(*) AS n FROM store_meta WHERE key LIKE 'gate-stuck:%'"),
      ).toEqual([{ n: 1 }]);
    } finally {
      s.close();
    }
  });

  it("reads a value that does not decode as none", () => {
    const s = openTestStore();
    try {
      const gate = metaGateStateStore(s.driver, A);
      for (const bad of [
        "not json",
        '{"device":"x"}',
        "null",
        "[1]",
        JSON.stringify([record(B), record(C, { kind: "stalled" })]),
        JSON.stringify([record(B, { passes: 0 })]),
        JSON.stringify([record(B, { seg: 1.5 })]),
        JSON.stringify([record(B, { code: "" })]),
        JSON.stringify([record(B, { firstSeenAt: "yesterday" })]),
      ]) {
        gate.saveStuck(bad);
        expect(gate.loadStuck(), bad).toBeUndefined();
      }
      // a corrupt stuck value leaves the gate's snapshot alone
      gate.save("{}\nab");
      gate.saveStuck("{");
      expect(gate.load()).toBe("{}\nab");
      expect(gate.loadStuck()).toBeUndefined();
    } finally {
      s.close();
    }
  });
});
