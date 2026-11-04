import { setLanguageForTests } from "@cashu/i18n";
import { expect, it } from "vitest";
import {
  connectorActionMessage,
  connectorEligibleAccounts,
  connectorParams,
  connectorScopeMatches,
  connectorStateForVault,
} from "./useSettingsScreen.js";

const firstVault = "5f0c3a9e81d24b7690ae13c7d2f4b856";
const secondVault = "3c8fb752e64d412e9434f73642b38590";
const connector = {
  id: "synthetic",
  name: "Synthetic",
  kind: "fetch" as const,
  module: "budget" as const,
  contentSha256: "a".repeat(64),
  interpreter: "/synthetic/interpreter",
  approval: "approved" as const,
  params: [
    { id: "enabled", label: "Enabled", type: "boolean", required: false },
    { id: "days", label: "Days", type: "number", required: true },
  ],
  secrets: [],
};
const snapshot = {
  connectors: [connector],
  accounts: [
    { gid: "6ad703ab-383d-8c73-82a5-1ee2d6742735", name: "Synthetic checking", type: "checking" },
    { gid: "8ad703ab-383d-8c73-82a5-1ee2d6742735", name: "Synthetic broker", type: "brokerage" },
  ],
  bindings: [],
};

it("hides an old vault immediately and ignores its late result generation", () => {
  const oldState = { vault: firstVault, snapshot, busy: true };
  expect(connectorStateForVault(oldState, secondVault)).toEqual({
    vault: secondVault,
    snapshot: null,
    busy: false,
  });
  expect(
    connectorScopeMatches(
      { vault: secondVault, generation: 1 },
      { vault: firstVault, generation: 0 },
    ),
  ).toBe(false);
});

it("reports failed and partial runs as failures and checks boolean/number binding inputs", () => {
  setLanguageForTests("en");
  expect(
    connectorActionMessage(
      { op: "run", binding: "6ad703ab-383d-8c73-82a5-1ee2d6742735" },
      { status: "completed", value: { status: "failed" } },
    ),
  ).toContain("Fetch failed");
  expect(
    connectorActionMessage(
      { op: "run", binding: "6ad703ab-383d-8c73-82a5-1ee2d6742735" },
      { status: "completed", value: { status: "partial" } },
    ),
  ).toContain("Fetch failed");
  expect(connectorParams(connector, { enabled: true, days: "30" })).toEqual({
    enabled: true,
    days: 30,
  });
  expect(connectorParams(connector, { enabled: false, days: "bad" })).toBeNull();
  expect(connectorEligibleAccounts(snapshot, connector).map((item) => item.type)).toEqual([
    "checking",
  ]);
});
