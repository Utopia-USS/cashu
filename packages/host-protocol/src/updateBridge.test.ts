import { describe, expect, it } from "vitest";
import { updateAdmissionRecord, updateHandoverCompleteRecord } from "./updateBridge.js";

const barrier = {
  schema: 1,
  id: "c".repeat(64),
  phase: "prepared",
  fromFingerprint: "a".repeat(64),
  fromVersion: "1.0.0",
  targetVersion: "2.0.0",
} as const;
const complete = {
  schema: 1,
  admissionId: "c".repeat(64),
  pid: 42,
  startedAt: "2026-01-01T00:00:00.000Z",
  build: "synthetic-host",
  dataDirId: "d".repeat(64),
} as const;

describe("update admission files", () => {
  it("accepts the exact barrier and completion records", () => {
    expect(updateAdmissionRecord.parse(barrier)).toEqual(barrier);
    expect(updateAdmissionRecord.parse({ ...barrier, phase: "dispatch_committed" })).toMatchObject({
      phase: "dispatch_committed",
    });
    expect(updateHandoverCompleteRecord.parse(complete)).toEqual(complete);
  });

  it.each([
    ["an extra key", { ...barrier, extra: 1 }],
    ["a missing key", { ...barrier, phase: undefined }],
    ["schema 2", { ...barrier, schema: 2 }],
    ["an unknown phase", { ...barrier, phase: "done" }],
    ["an uppercase id", { ...barrier, id: "C".repeat(64) }],
    ["a short fingerprint", { ...barrier, fromFingerprint: "a".repeat(63) }],
    ["a non-semver version", { ...barrier, fromVersion: "1.0" }],
    ["an overlong version", { ...barrier, targetVersion: `2.0.0-${"x".repeat(60)}` }],
    ["the same version", { ...barrier, targetVersion: "1.0.0" }],
    ["an array", [barrier]],
  ])("refuses a barrier with %s", (_label, value) => {
    expect(updateAdmissionRecord.safeParse(value).success).toBe(false);
  });

  it.each([
    ["an extra key", { ...complete, extra: 1 }],
    ["a missing key", { ...complete, build: undefined }],
    ["a string pid", { ...complete, pid: "42" }],
    ["schema 0", { ...complete, schema: 0 }],
    ["null", null],
  ])("refuses a completion with %s", (_label, value) => {
    expect(updateHandoverCompleteRecord.safeParse(value).success).toBe(false);
  });
});
