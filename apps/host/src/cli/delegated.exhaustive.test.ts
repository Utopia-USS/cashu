// The delegated table against the Python CLI's real top-level commands (oracle: the repo's .venv;
// skipped where there is no Python): every Python command is either ported or delegated with its S39
// slice, and nothing is routed that Python does not have.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup } from "../testing/harness.js";
import { HAS_PYTHON, python } from "../testing/python.js";
import { DELEGATED } from "./delegated.js";
import { portedCommands } from "./ported.js";

afterEach(cleanup);

describe.skipIf(!HAS_PYTHON)("delegated commands (Python oracle)", () => {
  it("cover exactly the Python CLI's top-level commands", () => {
    const names = python(
      "import typer.main\nfrom cashu.cli import app\nprint('\\n'.join(sorted(typer.main.get_command(app).commands)))",
    )
      .trim()
      .split("\n");
    const ported = portedCommands({ nativeStores: { vaults: new Map() } }).map((c) => c.name);
    // Native financial commands are enabled when Python is absent. During migration some
    // commands also remain delegated for mixed sessions.
    const nativeProduct = [
      ...ported.filter((name) => name !== "genesis" && name !== "command-status"),
      "app",
      "connectors",
      "worker",
      "workspace",
    ];
    expect([...new Set([...Object.keys(DELEGATED), ...nativeProduct])].sort()).toEqual(names);
    expect(new Set(Object.values(DELEGATED))).toEqual(new Set(["S39a", "S39b", "S39c", "S39d"]));
  });
});
