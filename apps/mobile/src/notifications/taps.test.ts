// A tapped notification's target: every kind's destination, the profile switch when it belongs to the
// other profile, and nothing for a vault this phone no longer holds or a foreign notification.
import { tapTarget } from "./taps";

const ANNA = "a1000000000000000000000000000001";
const HOME = "b2000000000000000000000000000002";
const VAULTS = [ANNA, HOME];

describe("tapTarget", () => {
  it("leads each kind to its screen", () => {
    const of = (kind: string, extra: Record<string, string> = {}) =>
      tapTarget({ vault: ANNA, kind, ...extra }, VAULTS, ANNA)?.destination;
    expect(of("alerts_fired")).toEqual({ kind: "signals" });
    for (const kind of ["evening", "weekly", "stale_data", "consent_ending"])
      expect(of(kind)).toEqual({ kind: "today" });
    expect(of("month_closed", { month: "2026-10" })).toEqual({ kind: "closed", month: "2026-10" });
    expect(of("month_closed", { month: "October" })).toEqual({ kind: "closed", month: null });
    expect(of("device_change")).toEqual({ kind: "profile" });
  });

  it("switches the profile first when the notification is the other one's", () => {
    expect(tapTarget({ vault: HOME, kind: "weekly" }, VAULTS, ANNA)).toEqual({
      switchTo: HOME,
      destination: { kind: "today" },
    });
    expect(tapTarget({ vault: ANNA, kind: "weekly" }, VAULTS, ANNA)?.switchTo).toBeNull();
  });

  it("ignores a vault this phone does not hold and a notification that is not ours", () => {
    expect(
      tapTarget({ vault: "c3000000000000000000000000000003", kind: "weekly" }, VAULTS, ANNA),
    ).toBeNull();
    expect(tapTarget({ kind: "weekly" }, VAULTS, ANNA)).toBeNull();
    expect(tapTarget({ vault: ANNA, kind: "streak" }, VAULTS, ANNA)).toBeNull();
  });
});
