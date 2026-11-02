import { expect, it } from "vitest";
import { portedCommands } from "./ported.js";

it("registers budget leaves only for a native-only host", () => {
  const mixed = new Set(portedCommands().map((command) => command.name));
  const native = new Set(
    portedCommands({ nativeStores: { vaults: new Map() } }).map((command) => command.name),
  );
  for (const name of [
    "budget",
    "cash",
    "cash-add",
    "import-csv",
    "import-dir",
    "categorize",
    "set-category",
    "reclassify",
    "match-transfers",
  ]) {
    expect(mixed.has(name), `mixed ${name}`).toBe(false);
    expect(native.has(name), `native ${name}`).toBe(true);
  }
});
