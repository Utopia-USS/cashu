import { describe, expect, it } from "vitest";
import { dailyDue, runIfDue } from "./autorun.js";

describe("Python autorun policy", () => {
  it("runs immediately at startup, later after 07:30, and partial counts as successful", () => {
    const now = { day: "2026-10-31", hour: 7, minute: 29 };
    expect(dailyDue(null, now, true)).toBe(true);
    expect(dailyDue(null, now, false)).toBe(false);
    expect(dailyDue("2026-10-31", now, true)).toBe(false);
    expect(dailyDue("2026-11-01", now, true)).toBe(false);
    expect(dailyDue("2026-10-30", { ...now, minute: 30 }, false)).toBe(true);
  });
  it("busy does not backfill and failed backfill never fails successful daily", async () => {
    let backfills = 0;
    const deps = {
      enabled: true,
      profiles: [{ vault: "a", lastOk: null }],
      now: { day: "2026-10-31", hour: 8, minute: 0 },
      atStart: false,
      async run() {
        return { status: "busy" };
      },
      async backfill() {
        backfills++;
        throw new Error("synthetic");
      },
    };
    expect((await runIfDue(deps)).status).toBe("busy");
    expect(backfills).toBe(0);
    expect(
      (
        await runIfDue({
          ...deps,
          async run() {
            return { status: "ran" };
          },
        })
      ).status,
    ).toBe("ran");
    expect(backfills).toBe(1);
  });
});
