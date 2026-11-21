/** Stored allocation-drift signals without a `bucket_generic` flag get it derived on read. */
import { expect, it } from "vitest";
import { driftBucketGeneric, withBucketGeneric } from "./allocationDriftRead.js";

it("derives the flag from the bucket id: a generic id or none is generic, a private name is not", () => {
  expect(withBucketGeneric("allocation_drift", { bucket_id: "equity" })).toEqual({
    bucket_id: "equity",
    bucket_generic: true,
  });
  expect(withBucketGeneric("allocation_drift", { bucket_id: "mieszkanie-dla-corki" })).toEqual({
    bucket_id: "mieszkanie-dla-corki",
    bucket_generic: false,
  });
  expect(driftBucketGeneric({})).toBe(true);
  expect(driftBucketGeneric(null)).toBe(true);
  expect(driftBucketGeneric({ bucket_id: 7 })).toBe(false);
  expect(driftBucketGeneric({ bucket_id: "equity", bucket_generic: false })).toBe(false);
});

it("keeps a stored flag (even a malformed one), other kinds and null payloads as they are, never mutating", () => {
  const flagged = { bucket_generic: "old malformed value" };
  expect(withBucketGeneric("allocation_drift", flagged)).toBe(flagged);
  const other = { bucket_id: "mieszkanie-dla-corki" };
  expect(withBucketGeneric("cash_level", other)).toBe(other);
  expect(withBucketGeneric("allocation_drift", null)).toBeNull();
  const stored = { bucket_id: "equity" };
  withBucketGeneric("allocation_drift", stored);
  expect(stored).toEqual({ bucket_id: "equity" });
});
