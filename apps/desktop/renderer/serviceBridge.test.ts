import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createServiceStatusCoordinator,
  type DesktopServiceStatus,
  parseServiceStatus,
  readServiceStatus,
  setServiceEnabled,
} from "./serviceBridge.js";

afterEach(() => vi.unstubAllGlobals());

describe("service bridge status", () => {
  it("never presents malformed status as enabled", () => {
    expect(parseServiceStatus({ state: "running" }).state).toBe("unavailable");
    expect(parseServiceStatus({ state: "enabled", nextWake: "not a date" })).toEqual({
      state: "enabled",
    });
    expect(parseServiceStatus({ state: "requires_approval" }).state).toBe("requires_approval");
  });

  it("returns the provider's observed toggle result and keeps failure distinct", async () => {
    const setEnabled = vi.fn(async (_enabled: boolean) => ({ state: "requires_approval" }));
    vi.stubGlobal("window", {
      cashuService: { status: async () => ({ state: "off" }), setEnabled },
    });
    expect((await readServiceStatus()).state).toBe("off");
    expect(await setServiceEnabled(true)).toEqual({ state: "requires_approval" });
    expect(setEnabled).toHaveBeenCalledExactlyOnceWith(true);
    setEnabled.mockRejectedValueOnce(new Error("synthetic failure"));
    expect((await setServiceEnabled(false)).state).toBe("error");
  });

  it("defers polling during a toggle and rejects an older off snapshot", async () => {
    let resolveOld!: (status: DesktopServiceStatus) => void;
    let resolveToggle!: (status: DesktopServiceStatus) => void;
    const statuses: DesktopServiceStatus[] = [];
    const read = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<DesktopServiceStatus>((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockResolvedValue({ state: "requires_approval" });
    const set = vi.fn(
      () =>
        new Promise<DesktopServiceStatus>((resolve) => {
          resolveToggle = resolve;
        }),
    );
    const flow = createServiceStatusCoordinator((status) => statuses.push(status), read, set);
    const oldPoll = flow.poll();
    const toggle = flow.toggle(true);
    expect(flow.busy).toBe(true);
    await flow.poll();
    expect(await flow.toggle(true)).toBeNull();
    resolveOld({ state: "off" });
    await oldPoll;
    expect(statuses).toEqual([]);
    resolveToggle({ state: "requires_approval" });
    await toggle;
    expect(statuses.map((status) => status.state)).toEqual([
      "requires_approval",
      "requires_approval",
    ]);
    expect(set).toHaveBeenCalledExactlyOnceWith(true);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
