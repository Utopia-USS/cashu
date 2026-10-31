// effectiveAlertStatus: every precedence edge at the `now` boundaries (Python
// service/alerts.py:housekeeping uses `<=` for expiry and for the snooze end). Synthetic rows only.
import { describe, expect, it } from "vitest";
import { type AlertStatusRow, effectiveAlertStatus } from "./effectiveStatus.js";

const NOW = "2026-11-01 12:00:00.000000";
const BEFORE = "2026-11-01 11:59:59.999999";
const AFTER = "2026-11-01 12:00:00.000001";
const row = (r: Partial<AlertStatusRow>): AlertStatusRow => ({
  status: "active",
  expires_at: null,
  snoozed_until: null,
  ...r,
});

describe("effectiveAlertStatus", () => {
  it("keeps a plain stored status", () => {
    for (const status of ["active", "triggered"] as const) {
      expect(effectiveAlertStatus(row({ status }), NOW)).toEqual({ status, snoozed_until: null });
    }
  });

  it("muted beats expiry (housekeeping never expires a muted alert)", () => {
    expect(effectiveAlertStatus(row({ status: "muted", expires_at: BEFORE }), NOW).status).toBe(
      "muted",
    );
  });

  it.each([
    ["active", BEFORE, "expired"],
    ["active", NOW, "expired"],
    ["active", AFTER, "active"],
    ["triggered", NOW, "expired"],
    ["triggered", AFTER, "triggered"],
    ["snoozed", NOW, "expired"],
  ] as const)("%s with expires_at %s reads %s", (status, expires, expected) => {
    const r = effectiveAlertStatus(
      row({ status, expires_at: expires, snoozed_until: status === "snoozed" ? AFTER : null }),
      NOW,
    );
    expect(r.status).toBe(expected);
    if (expected === "expired") expect(r.snoozed_until).toBeNull();
  });

  it.each([
    [BEFORE, "active", null],
    [NOW, "active", null],
    [AFTER, "snoozed", AFTER],
  ] as const)("snoozed until %s reads %s", (until, status, shown) => {
    expect(effectiveAlertStatus(row({ status: "snoozed", snoozed_until: until }), NOW)).toEqual({
      status,
      snoozed_until: shown,
    });
  });

  it("expiry beats a running snooze", () => {
    const r = effectiveAlertStatus(
      row({ status: "snoozed", snoozed_until: AFTER, expires_at: BEFORE }),
      NOW,
    );
    expect(r).toEqual({ status: "expired", snoozed_until: null });
  });

  it("compares instants across forms (ISO with offset, Z, naive storage)", () => {
    const r = row({ expires_at: "2026-11-01T13:00:00+01:00" });
    expect(effectiveAlertStatus(r, "2026-11-01T12:00:00Z").status).toBe("expired");
    expect(effectiveAlertStatus(r, "2026-11-01T11:59:59Z").status).toBe("active");
  });
});
