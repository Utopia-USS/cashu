import { describe, expect, it, vi } from "vitest";
import { activateHost } from "./activation.js";
import type { HostService } from "./types.js";

describe("service activation boundary", () => {
  it("uses the fixed enabled service without spawning a second host", async () => {
    const detached = vi.fn();
    const service = {
      status: vi.fn(async () => ({ state: "enabled" as const })),
      start: vi.fn(async () => ({ kind: "started" as const })),
    } satisfies Pick<HostService, "status" | "start">;
    expect(await activateHost(service, detached)).toBe("service");
    expect(service.start).toHaveBeenCalledOnce();
    expect(detached).not.toHaveBeenCalled();
  });

  it.each(["off", "requires_approval", "unavailable", "error"] as const)(
    "detaches when status is %s without requesting service start",
    async (state) => {
      const detached = vi.fn();
      const start = vi.fn(async () => ({ kind: "started" as const }));
      expect(await activateHost({ status: async () => ({ state }), start }, detached)).toBe(
        "detached",
      );
      expect(start).not.toHaveBeenCalled();
      expect(detached).toHaveBeenCalledOnce();
    },
  );

  it("detaches after an enabled service reports failure or throws", async () => {
    for (const start of [
      async () => ({ kind: "failed" as const }),
      async () => {
        throw Error("service unavailable");
      },
    ]) {
      const detached = vi.fn();
      expect(
        await activateHost({ status: async () => ({ state: "enabled" }), start }, detached),
      ).toBe("detached");
      expect(detached).toHaveBeenCalledOnce();
    }
  });
});
