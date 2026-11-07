// Core setup helpers (core/modules.py SetupStatus, cli_prefix): tests/test_first_steps_api.py
// test_optional_steps_never_count_and_are_never_current, test_setup_response_carries_the_cli_prefix (the
// prefix half); tests/test_profiles.py test_setup_endpoint_shape (the cli_prefix line). Python's
// shlex.quote / shlex.join cases are pinned by hand from CPython 3.12.

import { describe, expect, it } from "vitest";
import type { SetupStep } from "./modules.js";
import {
  claudeMcpAdd,
  claudeMcpRemove,
  cliPrefix,
  reconnectMcpCommands,
  setupView,
  shlexJoin,
  shlexQuote,
} from "./setup.js";

const steps = (...specs: (readonly [boolean, boolean])[]): SetupStep[] =>
  specs.map(([done, optional], i) => ({
    id: `s${i}`,
    title: "t",
    description: "d",
    done,
    actions: [],
    optional,
  }));

describe("setup status", () => {
  it("test_optional_steps_never_count_and_are_never_current", () => {
    expect(setupView(steps([false, false], [false, true])).state).toBe("empty");
    expect(setupView(steps([true, false], [false, true])).state).toBe("ready");
    // a done optional step: still empty
    expect(setupView(steps([false, false], [true, true])).state).toBe("empty");
    expect(setupView(steps([true, false], [false, false], [false, true])).state).toBe("partial");
    const view = setupView(steps([false, true], [false, false], [false, false]));
    expect(view.steps.map((d) => d.status)).toEqual(["todo", "on", "todo"]);
    expect(view.steps.map((d) => d.optional)).toEqual([true, false, false]);
  });

  it("no steps: empty", () => {
    expect(setupView([])).toEqual({ state: "empty", steps: [] });
  });
});

describe("cli prefix", () => {
  it("cashu --profile <slug> (test_setup_response_carries_the_cli_prefix)", () => {
    expect(cliPrefix(["cashu"], "jan")).toBe("cashu --profile jan");
    expect(cliPrefix(["cashu"], null)).toBe("cashu");
  });

  it("the packaged binary's path is quoted for the shell", () => {
    expect(cliPrefix(["/Applications/cashU.app/Contents/MacOS/cashu"], "jan")).toBe(
      "/Applications/cashU.app/Contents/MacOS/cashu --profile jan",
    );
    expect(cliPrefix(["/Users/x/My Apps/cashU.app/cashu"], "anna-2")).toBe(
      "'/Users/x/My Apps/cashU.app/cashu' --profile anna-2",
    );
  });

  it("claude mcp add line of the profile (runtime.claude_mcp_add)", () => {
    expect(claudeMcpAdd(["/Users/x/Library/Application Support/cashU/bin/cashu"], "jan")).toBe(
      "claude mcp add cashu-jan -- '/Users/x/Library/Application Support/cashU/bin/cashu' mcp --profile jan",
    );
  });

  it("reconnect lines after a Python import: remove the old name, then the setup screen's add", () => {
    expect(claudeMcpRemove("jan")).toBe("claude mcp remove cashu-jan");
    const launcher = "/Users/x/Library/Application Support/cashU/bin/cashu";
    expect(reconnectMcpCommands([launcher], ["jan", "dom-2"])).toEqual([
      "claude mcp remove cashu-jan",
      claudeMcpAdd([launcher], "jan"),
      "claude mcp remove cashu-dom-2",
      claudeMcpAdd([launcher], "dom-2"),
    ]);
    expect(reconnectMcpCommands([launcher], [])).toEqual([]);
  });

  it("shlex.quote", () => {
    expect(shlexQuote("")).toBe("''");
    expect(shlexQuote("safe-@%+=:,./_A9")).toBe("safe-@%+=:,./_A9");
    expect(shlexQuote("a b")).toBe("'a b'");
    expect(shlexQuote("it's")).toBe(`'it'"'"'s'`);
    expect(shlexQuote("żółw")).toBe("'żółw'"); // \w is ASCII in shlex (re.ASCII)
    expect(shlexQuote("$HOME")).toBe("'$HOME'");
    expect(shlexJoin(["claude", "mcp", "add", "cashu-jan", "--", "cashu"])).toBe(
      "claude mcp add cashu-jan -- cashu",
    );
  });
});
