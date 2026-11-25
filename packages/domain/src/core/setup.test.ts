// Core setup helpers (core/modules.py SetupStatus, cli_prefix): tests/test_first_steps_api.py
// test_optional_steps_never_count_and_are_never_current, test_setup_response_carries_the_cli_prefix (the
// prefix half); tests/test_profiles.py test_setup_endpoint_shape (the cli_prefix line). Python's
// shlex.quote / shlex.join cases are pinned by hand from CPython 3.12.

import { describe, expect, it } from "vitest";
import type { SetupStep } from "./modules.js";
import {
  claudeMcpAdd,
  claudeMcpAddLine,
  cliPrefix,
  cmdLineSafe,
  powershellQuote,
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
    expect(
      claudeMcpAdd(["/Users/x/Library/Application Support/cashU/bin/cashu"], "jan", "cashu"),
    ).toBe(
      "claude mcp add cashu-jan -- '/Users/x/Library/Application Support/cashU/bin/cashu' mcp --profile jan",
    );
    expect(
      claudeMcpAdd(
        ["/Users/x/Library/Application Support/cashU Staging/bin/cashu"],
        "jan",
        "cashu-staging",
      ),
    ).toBe(
      "claude mcp add cashu-staging-jan -- '/Users/x/Library/Application Support/cashU Staging/bin/cashu' mcp --profile jan",
    );
  });

  it("an explicit macOS or Linux platform renders exactly the sh form", () => {
    const launcher = "/Users/x/Library/Application Support/cashU/bin/cashu";
    for (const platform of ["darwin", "linux"]) {
      expect(cliPrefix([launcher], "jan", platform)).toBe(cliPrefix([launcher], "jan"));
      expect(claudeMcpAdd([launcher], "jan", "cashu", platform)).toBe(
        claudeMcpAdd([launcher], "jan", "cashu"),
      );
    }
  });

  const WINDOWS_LAUNCHER = "C:\\Users\\Jan Kowalski\\AppData\\Local\\cashU\\bin\\cashu.cmd";

  it("Windows: PowerShell runs the launcher through the call operator", () => {
    expect(cliPrefix([WINDOWS_LAUNCHER], "jan", "win32")).toBe(
      '& "C:\\Users\\Jan Kowalski\\AppData\\Local\\cashU\\bin\\cashu.cmd" --profile jan',
    );
    expect(cliPrefix(["cashu"], "jan", "win32")).toBe("cashu --profile jan");
    expect(cliPrefix([WINDOWS_LAUNCHER], null, "win32")).toBe(
      '& "C:\\Users\\Jan Kowalski\\AppData\\Local\\cashU\\bin\\cashu.cmd"',
    );
  });

  it("Windows: the MCP server runs the .cmd launcher through cmd, which Claude Code can spawn", () => {
    expect(claudeMcpAdd([WINDOWS_LAUNCHER], "jan", "cashu", "win32")).toBe(
      'claude mcp add cashu-jan "--" cmd /d /c "C:\\Users\\Jan Kowalski\\AppData\\Local\\cashU\\bin\\cashu.cmd" mcp --profile jan',
    );
    expect(claudeMcpAdd(["D:\\cashu\\bin\\cashu.cmd"], "anna-2", "cashu", "win32")).toBe(
      'claude mcp add cashu-anna-2 "--" cmd /d /c "D:\\cashu\\bin\\cashu.cmd" mcp --profile anna-2',
    );
  });

  it("Windows: no MCP line for a launcher path cmd.exe would reinterpret", () => {
    for (const path of [
      "C:\\Users\\Tom & Jerry\\cashu.cmd",
      "C:\\Users\\Jan (Work)\\cashu.cmd",
      "C:\\Users\\a^b\\cashu.cmd",
      "C:\\Users\\wow!\\cashu.cmd",
      "C:\\Users\\100%\\cashu.cmd",
    ])
      expect(claudeMcpAdd([path], "jan", "cashu", "win32")).toBeNull();
    // The CLI line is PowerShell's own quoting, which carries them.
    expect(cliPrefix(["C:\\Users\\Tom & Jerry\\cashu.cmd"], "jan", "win32")).toBe(
      '& "C:\\Users\\Tom & Jerry\\cashu.cmd" --profile jan',
    );
  });

  it("the claude mcp add line from pre-quoted words, shared with the recovery prompt", () => {
    expect(claudeMcpAddLine("cashu-<slug>", "pnpm cashu-next mcp --profile <slug>")).toBe(
      "claude mcp add cashu-<slug> -- pnpm cashu-next mcp --profile <slug>",
    );
    expect(claudeMcpAddLine("cashu-<slug>", "pnpm cashu-next mcp --profile <slug>", "linux")).toBe(
      "claude mcp add cashu-<slug> -- pnpm cashu-next mcp --profile <slug>",
    );
    expect(
      claudeMcpAddLine(
        "cashu-<slug>",
        '"$env:USERPROFILE\\x\\cashu.cmd" mcp --profile <slug>',
        "win32",
      ),
    ).toBe(
      'claude mcp add cashu-<slug> "--" cmd /d /c "$env:USERPROFILE\\x\\cashu.cmd" mcp --profile <slug>',
    );
    expect(cmdLineSafe("C:\\Users\\Jan Kowalski\\cashu.cmd")).toBe(true);
    for (const word of [
      "a&b",
      "a(b",
      "a)b",
      "a^b",
      "a|b",
      "a<b",
      "a>b",
      "a@b",
      "a%b",
      "a!b",
      'a"b',
      "a\nb",
    ])
      expect(cmdLineSafe(word)).toBe(false);
  });

  it("PowerShell quoting", () => {
    expect(powershellQuote("cashu-jan")).toBe("cashu-jan");
    expect(powershellQuote("--profile")).toBe("--profile");
    expect(powershellQuote("/c")).toBe("/c");
    expect(powershellQuote("--")).toBe('"--"');
    expect(powershellQuote("")).toBe('""');
    expect(powershellQuote("a b")).toBe('"a b"');
    expect(powershellQuote("C:\\x")).toBe('"C:\\x"');
    expect(powershellQuote('$env:X `a` "q" \u201Cs\u201D')).toBe(
      '"`$env:X ``a`` `"q`" `\u201Cs`\u201D"',
    );
    expect(powershellQuote("@splat")).toBe('"@splat"');
    expect(powershellQuote("a,b")).toBe('"a,b"');
    expect(powershellQuote("it's")).toBe('"it\'s"');
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
