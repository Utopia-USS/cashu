// D7 status summary: counts per kind, and the one writer the Sync row names (the oldest rejected
// stream, else the oldest waiting one; a `final` stream is expected and never named).
import type { StuckRecord } from "@cashu/sync";
import { expect, it } from "vitest";
import { stuckSummary } from "./service.js";

const A = "a".repeat(32);
const B = "b".repeat(32);
const C = "c".repeat(32);
const record = (device: string, kind: StuckRecord["kind"], firstSeenAt: number): StuckRecord =>
  ({ device, seg: 1, offset: 0, code: "synthetic", kind, firstSeenAt, passes: 1 }) as StuckRecord;

it("names the oldest rejected writer before any waiting one", () => {
  expect(
    stuckSummary([record(A, "waiting", 1), record(B, "rejected", 5), record(C, "rejected", 3)]),
  ).toEqual({ waiting: 1, rejected: 2, final: 0, since: 1, passes: 1, device: C });
});

it("names the oldest waiting writer when nothing is rejected, never a final one", () => {
  expect(
    stuckSummary([record(C, "final", 0), record(B, "waiting", 7), record(A, "waiting", 4)]),
  ).toEqual({ waiting: 2, rejected: 0, final: 1, since: 4, passes: 1, device: A });
  expect(stuckSummary([record(C, "final", 0)])).toEqual({
    waiting: 0,
    rejected: 0,
    final: 1,
    passes: 0,
  });
  expect(stuckSummary([])).toBeUndefined();
});
