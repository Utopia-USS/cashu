// The S38 assignment of the Python MCP tools against the Python registry (oracle: the repo's .venv;
// skipped where there is no Python): every tool has exactly one slice, nothing extra is listed.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup } from "../testing/harness.js";
import { HAS_PYTHON, python } from "../testing/python.js";
import { PYTHON_TOOLS } from "./tools.js";

afterEach(cleanup);

describe.skipIf(!HAS_PYTHON)("Python MCP tools (Python oracle)", () => {
  it("are each assigned to one S38 slice", () => {
    const names = python(
      "from cashu.core.mcp.registry import all_tools\nprint('\\n'.join(sorted(all_tools())))",
    )
      .trim()
      .split("\n");
    expect(Object.keys(PYTHON_TOOLS).sort()).toEqual(names);
    expect(names).toHaveLength(45);
  });
});
