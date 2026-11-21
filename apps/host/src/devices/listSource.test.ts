import { expect, it, vi } from "vitest";
import type { HostStores } from "../stores.js";
import { deviceListSource } from "./listSource.js";

const vault = "a".repeat(32);

function fixture() {
  let devices = 1;
  const changed = new Set<() => void>();
  const native = {
    isCurrent: () => true,
    deviceList: vi.fn(async () => ({ kind: "ready", devices: devices }) as never),
    onDevicesChanged(listener: () => void) {
      changed.add(listener);
      return () => changed.delete(listener);
    },
  };
  const stores = { vaults: new Map([[vault, { native }]]) } as unknown as HostStores;
  return {
    source: deviceListSource(() => stores),
    native,
    pair() {
      devices++;
      for (const listener of [...changed]) listener();
    },
    watched: () => changed.size,
  };
}

it("checks a vault's list once asked and pushes it again after each device change", async () => {
  const f = fixture();
  const pushed = vi.fn();
  const stop = f.source.changes.subscribe(pushed);
  expect(f.source.state(vault)).toEqual({ status: "loading" });
  await vi.waitFor(() =>
    expect(f.source.state(vault)).toEqual({ status: "ready", list: { kind: "ready", devices: 1 } }),
  );
  expect(pushed).toHaveBeenCalledTimes(1);
  f.pair();
  await vi.waitFor(() =>
    expect(f.source.state(vault)).toEqual({ status: "ready", list: { kind: "ready", devices: 2 } }),
  );
  expect(pushed).toHaveBeenCalledTimes(2);
  stop();
  expect(f.watched()).toBe(0);
  f.pair();
  expect(f.native.deviceList).toHaveBeenCalledTimes(2);
});

it("answers unavailable for a vault without a current native session", () => {
  const f = fixture();
  expect(f.source.state("b".repeat(32))).toEqual({ status: "unavailable" });
});
