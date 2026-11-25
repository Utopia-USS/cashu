import { describe, expect, it, vi } from "vitest";
import { createDesktopHostService, nextDailyWake } from "./runtime.js";

const base = {
  platform: "linux" as const,
  packaged: true,
  dataDir: "/home/test/.local/share/cashu",
  home: "/home/test",
  env: {},
  launcherReady: false,
};

describe("desktop host service eligibility", () => {
  it("does not ask the OS in a development or unbound packaged runtime", async () => {
    const run = vi.fn();
    const dev = createDesktopHostService({
      ...base,
      packaged: false,
      launcherReady: true,
      runner: { run },
    });
    const missing = createDesktopHostService({ ...base, runner: { run } });
    const custom = createDesktopHostService({
      ...base,
      launcherReady: true,
      dataDir: "/tmp/custom",
      runner: { run },
    });
    const mac = createDesktopHostService({ ...base, platform: "darwin", runner: { run } });
    for (const service of [dev, missing, custom, mac]) {
      expect((await service.status()).state).toBe("unavailable");
      expect((await service.enable()).state).toBe("unavailable");
      expect((await service.start()).kind).toBe("unavailable");
    }
    expect(run).not.toHaveBeenCalled();
  });

  it("reports the next local calendar wake without claiming a worker ran", () => {
    expect(nextDailyWake(new Date(2026, 10, 3, 7, 29))).toBe(
      new Date(2026, 10, 3, 7, 30).toISOString(),
    );
    expect(nextDailyWake(new Date(2026, 10, 3, 7, 31))).toBe(
      new Date(2026, 10, 4, 7, 30).toISOString(),
    );
  });
});
