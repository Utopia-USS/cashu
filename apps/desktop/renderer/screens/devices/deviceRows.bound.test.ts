import { expect, it } from "vitest";
import { OFFLINE_BOUND_DAYS } from "./deviceRows.js";

// The renderer cannot import @cashu/sync (not a dependency of @cashu/desktop, and the device list does
// not carry the bound), so OFFLINE_BOUND_DAYS mirrors sync's OFFLINE_LEAD_MAX_MS. This test reads the
// constant from sync's source (a file read, not an import: packages are imported by name only) and
// fails when the two diverge.
const sources = import.meta.glob<string>("../../../../../packages/sync/src/devices/lease.ts", {
  query: "?raw",
  import: "default",
  eager: true,
});

it("keeps the paused-fetch texts' 7 days equal to sync's offline lead bound", () => {
  const source = Object.values(sources)[0];
  expect(source).toBeTypeOf("string");
  const match = /export const OFFLINE_LEAD_MAX_MS = ([\d_ *]+);/.exec(source ?? "");
  expect(match).not.toBeNull();
  const ms = (match?.[1] ?? "")
    .split("*")
    .map((factor) => Number(factor.trim().replaceAll("_", "")))
    .reduce((product, factor) => product * factor, 1);
  expect(ms).toBe(OFFLINE_BOUND_DAYS * 86_400_000);
});
