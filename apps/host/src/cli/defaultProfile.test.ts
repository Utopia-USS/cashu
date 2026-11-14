import { expect, it } from "vitest";
import type { HostStores, OpenVault } from "../stores.js";
import { defaultProfileSlug } from "./defaultProfile.js";

function stores(rows: readonly (readonly [string, string, string] | readonly [string])[]) {
  const vaults = new Map<string, OpenVault>();
  for (const row of rows) {
    const [id, slug, createdAt] = row;
    vaults.set(id, {
      id,
      store: { read: () => (slug && createdAt ? [{ slug, createdAt }] : []) },
    } as unknown as OpenVault);
  }
  return { vaults } satisfies Pick<HostStores, "vaults">;
}

it("selects the oldest persisted profile regardless of vault map order", () => {
  expect(
    defaultProfileSlug(
      stores([
        ["new", "newer", "2026-11-02 12:00:00.000000"],
        ["old", "older", "2026-11-01 12:00:00.000000"],
      ]),
    ),
  ).toBe("older");
});

it("refuses a default when any opened vault has unavailable or invalid profile metadata", () => {
  expect(
    defaultProfileSlug(stores([["new", "newer", "2026-11-02 12:00:00.000000"], ["old"]])),
  ).toBeUndefined();
  expect(defaultProfileSlug(stores([["bad", "bad", "yesterday"]]))).toBeUndefined();
  expect(
    defaultProfileSlug(
      stores([
        ["a", "alpha", "2026-11-01 12:00:00.000000"],
        ["b", "beta", "2026-11-01 12:00:00.000000"],
      ]),
    ),
  ).toBeUndefined();
  expect(defaultProfileSlug(stores([]))).toBeUndefined();
});
