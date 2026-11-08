// The propagation claim (carrier.ts `TransportConsistency`, S29c R4) is tested, not assumed: the
// carrier contract suite runs `checkPropagationClaim` for every carrier, and this file shows the check
// passes an honest relay and FAILS a relay whose replicas lag longer than it declares, and one that
// declares a bound it cannot be tested on.
import { describe, expect, it } from "vitest";
import type { DeviceId } from "./carrier.js";
import { checkPropagationClaim, ManualClock, SimulatedRelay } from "./testing/index.js";

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 31, 12, 0, 0);

function relay(declaredMs: number, actualDelayMs: number) {
  const clock = new ManualClock(T0);
  const sim = new SimulatedRelay({
    clock,
    consistency: { kind: "bounded", propagationMs: declaredMs },
    actualDelayMs,
  });
  return {
    remoteFor: (device: DeviceId) => sim.handle(device),
    elapse: async (ms: number) => clock.advance(ms),
    settle: () => sim.settle(),
  };
}

describe("propagation claim check", () => {
  it("passes a relay whose replicas lag exactly the declared bound", async () => {
    const verdict = await checkPropagationClaim(relay(2 * MIN, 2 * MIN), "v1");
    expect(verdict).toMatchObject({ claimed: true, ok: true, violations: [] });
  });

  it("fails a relay that declares 2 minutes but lags 10 (eventually consistent storage behind it)", async () => {
    const verdict = await checkPropagationClaim(relay(2 * MIN, 10 * MIN), "v1");
    expect(verdict.claimed).toBe(true);
    expect(verdict.ok).toBe(false);
    expect(verdict.violations.length).toBeGreaterThan(0);
  });

  it("fails a lag of one millisecond over the bound", async () => {
    const verdict = await checkPropagationClaim(relay(2 * MIN, 2 * MIN + 1), "v1");
    expect(verdict.ok).toBe(false);
  });

  it("fails a bounded claim the medium cannot let time pass for, and an invalid bound", async () => {
    const { remoteFor } = relay(2 * MIN, 0);
    const untestable = await checkPropagationClaim({ remoteFor }, "v1");
    expect(untestable.ok).toBe(false);
    expect(untestable.violations).toEqual(["a bounded claim needs medium.elapse to be tested"]);
    const clock = new ManualClock(T0);
    const bad = new SimulatedRelay({
      clock,
      consistency: { kind: "bounded", propagationMs: -1 },
      actualDelayMs: 0,
    });
    const invalid = await checkPropagationClaim({ remoteFor: (d) => bad.handle(d) }, "v1");
    expect(invalid.ok).toBe(false);
  });

  it("an eventual transport claims nothing and passes without a check", async () => {
    const clock = new ManualClock(T0);
    const folderLike = new SimulatedRelay({
      clock,
      consistency: { kind: "eventual" },
      actualDelayMs: 48 * 60 * MIN,
    });
    const verdict = await checkPropagationClaim({ remoteFor: (d) => folderLike.handle(d) }, "v1");
    expect(verdict).toMatchObject({ claimed: false, ok: true });
  });
});
