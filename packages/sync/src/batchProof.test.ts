import { expect, it } from "vitest";
import { ownBatchDigest } from "./batchProof.js";

it("binds parsed null-prototype records to the same canonical batch proof", () => {
  const plain = {
    t: "proposal.created",
    v: 1,
    i: "synthetic-event",
    d: { payload: { blob: { ext: "csv", sha256: "synthetic" } } },
  };
  const parsed = {
    ...plain,
    d: {
      payload: Object.assign(Object.create(null) as Record<string, unknown>, {
        blob: Object.assign(Object.create(null) as Record<string, unknown>, {
          sha256: "synthetic",
          ext: "csv",
        }),
      }),
    },
  };
  expect(ownBatchDigest([parsed])).toBe(ownBatchDigest([plain]));
  expect(() => ownBatchDigest([{ ...plain, d: { payload: new Map() } }])).toThrow(
    "batch proof requires canonical JSON",
  );
});
