import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { driftBucketGeneric, withBucketGeneric } from "./allocationDriftRead.js";

const fixture = JSON.parse(
  readFileSync(new URL("../../alerts/fixtures/signal-read-vectors.json", import.meta.url), "utf8"),
) as {
  buckets: readonly {
    kind: string;
    payload: Record<string, unknown> | null;
    generic: boolean;
    expected: unknown;
  }[];
};

it.each(fixture.buckets)(
  "matches Python allocation drift read backfill for $kind",
  ({ kind, payload, generic, expected }) => {
    const before = payload === null ? null : { ...payload };
    expect(driftBucketGeneric(payload)).toBe(generic);
    expect(withBucketGeneric(kind, payload)).toEqual(expected);
    expect(payload).toEqual(before);
  },
);

it("retains the original object when a flag is present, including an invalid flag", () => {
  const payload = { bucket_generic: "old malformed value" };
  expect(withBucketGeneric("allocation_drift", payload)).toBe(payload);
});
