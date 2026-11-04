// Compare the native product command inventory with the frozen Python CLI oracle. This is an
// inventory check, not a runtime fallback: Python-only names must be explicitly retired.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup } from "../testing/harness.js";
import { HAS_PYTHON, python } from "../testing/python.js";
import { portedCommands } from "./ported.js";

afterEach(cleanup);

describe.skipIf(!HAS_PYTHON)("native command inventory", () => {
  it("accounts for each frozen top-level Python command", () => {
    const pythonNames = python(
      "import typer.main\nfrom cashu.cli import app\nprint('\\n'.join(sorted(typer.main.get_command(app).commands)))",
    )
      .trim()
      .split("\n");
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
