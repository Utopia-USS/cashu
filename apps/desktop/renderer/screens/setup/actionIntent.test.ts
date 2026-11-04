import { expect, it } from "vitest";
import { setupActionIntent } from "./actionIntent.js";

const enabled = new Set(["budget", "loans"]);
it("accepts only enabled native destinations and copy-only CLI intents", () => {
  expect(
    setupActionIntent(
      "budget",
      { kind: "tab", label: "Expenses", target: "expenses" },
      enabled,
      true,
    ),
  ).toEqual({
    kind: "navigate",
    target: { kind: "module", module: "budget", tab: "expenses" },
  });
  expect(
    setupActionIntent(
      "budget",
      { kind: "tab", label: "Other", target: "investments.portfolio" },
      enabled,
      true,
    ),
  ).toBeNull();
  expect(
    setupActionIntent(
      "budget",
      { kind: "url", label: "Unsafe", target: "javascript:run()" },
      enabled,
      true,
    ),
  ).toBeNull();
  expect(
    setupActionIntent(
      "budget",
      { kind: "cli", label: "Import", target: "cashu import-csv" },
      enabled,
      false,
    ),
  ).toBeNull();
  expect(
    setupActionIntent(
      "budget",
      { kind: "cli", label: "Import", target: "cashu import-csv" },
      enabled,
      true,
    ),
  ).toEqual({ kind: "copy", text: "cashu import-csv" });
});
