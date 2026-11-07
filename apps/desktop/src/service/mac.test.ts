import { describe, expect, it, vi } from "vitest";
import type { MacRuntime, MainProcessAgentBridge, NativeAgentStatus } from "./mac.js";
import { MAC_APP_BUNDLE_ID, MacHostService, mapNativeAgentStatus } from "./mac.js";

function fixture(status: NativeAgentStatus = "notRegistered") {
  let nativeStatus = status;
  const bridge: MainProcessAgentBridge = {
    identity: vi.fn(async () => ({
      bundleId: MAC_APP_BUNDLE_ID,
      bundlePath: "/Applications/cashU.app",
    })),
    status: vi.fn(async () => nativeStatus),
    register: vi.fn(async () => {
      nativeStatus = "requiresApproval";
    }),
    unregister: vi.fn(async () => {
      nativeStatus = "notRegistered";
    }),
    activate: vi.fn(async () => true),
  };
  const runtime: MacRuntime = {
    platform: "darwin",
    osReleaseMajor: 22,
    isPackaged: true,
    dataDir: "/Users/test/Library/Application Support/cashU",
    home: "/Users/test",
    bridge,
  };
  return { bridge, runtime, service: new MacHostService(runtime) };
}

describe("macOS service adapter", () => {
  it("maps all native statuses without treating approval as enabled", () => {
    expect(mapNativeAgentStatus("notRegistered").state).toBe("off");
    expect(mapNativeAgentStatus("enabled").state).toBe("enabled");
    expect(mapNativeAgentStatus("requiresApproval").state).toBe("requires_approval");
    expect(mapNativeAgentStatus("notFound")).toEqual({
      state: "error",
      reason: "agent_not_found",
    });
  });

  it("registers only the exact packaged identity and rereads approval status", async () => {
    const f = fixture();
    expect(await f.service.enable()).toEqual({ state: "requires_approval" });
    expect(f.bridge.register).toHaveBeenCalledOnce();
    expect(f.bridge.activate).not.toHaveBeenCalled();
  });

  it.each([
    { isPackaged: false },
    { platform: "linux" as const },
    { osReleaseMajor: 21 },
    { dataDir: "/Users/test/custom" },
  ])("refuses registration for ineligible runtime %o", async (change) => {
    const f = fixture();
    const service = new MacHostService({ ...f.runtime, ...change });
    expect((await service.enable()).state).toBe("unavailable");
    expect(f.bridge.register).not.toHaveBeenCalled();
  });

  it("refuses a different native app identity", async () => {
    const f = fixture();
    f.bridge.identity = vi.fn(async () => ({
      bundleId: "io.utopiasoft.cashu.next",
      bundlePath: "/Applications/cashU.app",
    }));
    expect((await new MacHostService(f.runtime).enable()).state).toBe("unavailable");
    expect(f.bridge.register).not.toHaveBeenCalled();
  });

  it("starts only enabled service and reports failed activation", async () => {
    const off = fixture();
    expect(await off.service.start()).toEqual({ kind: "unavailable" });
    expect(off.bridge.activate).not.toHaveBeenCalled();
    const enabled = fixture("enabled");
    enabled.bridge.activate = vi.fn(async () => false);
    expect(await new MacHostService(enabled.runtime).start()).toEqual({
      kind: "failed",
      reason: "native_activate_failed",
    });
  });

  it("keeps trusted native method bindings after caller mutation", async () => {
    const f = fixture("enabled");
    f.bridge.identity = vi.fn(async () => ({ bundleId: "wrong", bundlePath: "/tmp/wrong.app" }));
    f.bridge.activate = vi.fn(async () => false);
    Object.assign(f.runtime, { dataDir: "/Users/test/custom" });
    expect(await f.service.start()).toEqual({ kind: "started" });
  });

  it("unregisters only a registered exact agent", async () => {
    const f = fixture("requiresApproval");
    expect((await f.service.disable()).state).toBe("off");
    expect(f.bridge.unregister).toHaveBeenCalledOnce();
  });
});
