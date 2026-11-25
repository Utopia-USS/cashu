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

  it("lets a toggle in flight win over an older read and a push from main", async () => {
    let resolveOld!: (status: DesktopServiceStatus) => void;
    let resolveToggle!: (status: DesktopServiceStatus) => void;
    const statuses: DesktopServiceStatus[] = [];
    const read = vi.fn(
      () =>
        new Promise<DesktopServiceStatus>((resolve) => {
          resolveOld = resolve;
        }),
    );
    const set = vi.fn(
      () =>
        new Promise<DesktopServiceStatus>((resolve) => {
          resolveToggle = resolve;
        }),
    );
    const flow = createServiceStatusCoordinator((status) => statuses.push(status), read, set);
    const oldLoad = flow.load();
    const toggle = flow.toggle(true);
    expect(flow.busy).toBe(true);
    flow.pushed({ state: "off" });
    await flow.load();
    expect(await flow.toggle(true)).toBeNull();
    resolveOld({ state: "off" });
    await oldLoad;
    expect(statuses).toEqual([]);
    resolveToggle({ state: "requires_approval" });
    await toggle;
    flow.pushed({ state: "enabled" });
    expect(statuses.map((status) => status.state)).toEqual(["requires_approval", "enabled"]);
    expect(set).toHaveBeenCalledExactlyOnceWith(true);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("a push from main supersedes a first read still in flight", async () => {
    let resolveRead!: (status: DesktopServiceStatus) => void;
    const statuses: DesktopServiceStatus[] = [];
    const read = vi.fn(
      () =>
        new Promise<DesktopServiceStatus>((resolve) => {
          resolveRead = resolve;
        }),
    );
    const flow = createServiceStatusCoordinator((status) => statuses.push(status), read);
    const load = flow.load();
    flow.pushed({ state: "enabled" });
    resolveRead({ state: "requires_approval" });
    await load;
    expect(statuses.map((status) => status.state)).toEqual(["enabled"]);
  });
});
