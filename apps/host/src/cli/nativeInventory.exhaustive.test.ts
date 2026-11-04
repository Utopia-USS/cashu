// Compare the native product command inventory with the frozen top-level commands of the retired
// Python CLI: every Python name is either native or explicitly retired.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup } from "../testing/harness.js";
import { portedCommands } from "./ported.js";

afterEach(cleanup);

/** The top-level commands of the last Python CLI (typer), frozen when Python was retired. */
const PYTHON_COMMANDS = [
  "accounts",
  "add-position",
  "app",
  "assets",
  "budget",
  "cash",
  "cash-add",
  "categorize",
  "connectors",
  "eb",
  "import-csv",
  "import-dir",
  "init-db",
  "invest",
  "loans",
  "match-transfers",
  "mcp",
  "migrate-data",
  "profiles",
  "reclassify",
  "secrets",
  "serve",
  "set-account-name",
  "set-account-type",
  "set-balance",
  "set-category",
  "set-loan",
  "set-vehicle",
  "skills",
  "stats",
  "sync",
  "worker",
  "workspace",
];

describe("native command inventory", () => {
  it("accounts for each frozen top-level Python command", () => {
    const pythonNames = PYTHON_COMMANDS;
    const native = new Set([
      ...portedCommands({ nativeStores: { vaults: new Map() } })
        .map((command) => command.name)
        .filter((name) => name !== "genesis"),
      "app",
      "mcp",
      "host",
      // These groups need host capabilities, so the minimal portedCommands fixture omits them.
      "connectors",
      "eb",
      "invest",
      "worker",
      "workspace",
    ]);
    const retired = ["init-db", "migrate-data", "secrets", "serve", "sync"];
    expect(pythonNames.filter((name) => !native.has(name)).sort()).toEqual(retired);
  });
});
