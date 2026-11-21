// The gate a hosted command passes before it starts: open while no vault syncs, a wait for the first
// syncing vault's pass otherwise, and open for good once the budget ran out or the command was
// cancelled.
import { describe, expect, it } from "vitest";
import { type SyncingSession, syncGate } from "./syncGate.js";

function session(syncing: boolean): SyncingSession & { settle(): void; listeners(): number } {
  const listeners = new Set<() => void>();
  let state = syncing;
  return {
    isSyncing: () => state,
    onSyncSettled(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    settle() {
      state = false;
      for (const listener of [...listeners]) listener();
    },
    listeners: () => listeners.size,
  };
}

describe("syncGate", () => {
  it("is open when no session syncs", () => {
    const gate = syncGate(() => [session(false), session(false)], new AbortController().signal);
    expect(gate()).toBeUndefined();
  });

  it("waits for a syncing session's pass, then opens and unsubscribes", async () => {
    const idle = session(false);
    const busy = session(true);
    const gate = syncGate(() => [idle, busy], new AbortController().signal);
    const wait = gate();
    expect(wait).toBeInstanceOf(Promise);
    expect(busy.listeners()).toBe(1);
    busy.settle();
    await wait;
    expect(busy.listeners()).toBe(0);
    expect(gate()).toBeUndefined();
  });

  it("opens for good once the budget ran out", async () => {
    let clock = 1_000;
    const busy = session(true);
    const gate = syncGate(() => [busy], new AbortController().signal, {
      timeoutMs: 5,
      now: () => clock,
    });
    const wait = gate();
    await wait;
    expect(busy.listeners()).toBe(0);
    clock += 5;
    expect(gate()).toBeUndefined();
  });

  it("opens when the command is cancelled", async () => {
    const busy = session(true);
    const abort = new AbortController();
    const gate = syncGate(() => [busy], abort.signal);
    const wait = gate();
    abort.abort();
    await wait;
    expect(busy.listeners()).toBe(0);
    expect(gate()).toBeUndefined();
  });
});
