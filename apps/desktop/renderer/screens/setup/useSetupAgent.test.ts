import { describe, expect, it } from "vitest";
import { setupAgentContext } from "./useSetupAgent.js";

const MAC = {
  availability: "ready" as const,
  launcher: "/Users/synthetic/Library/Application Support/cashU/bin/cashu",
  mcpServerPrefix: "cashu",
};
const WINDOWS = {
  ...MAC,
  launcher: "C:\\Users\\Synthetic User\\AppData\\Local\\cashU\\bin\\cashu.cmd",
};

describe("setup agent card commands", () => {
  it("macOS and Linux: sh commands, the same with or without a platform", () => {
    const ready = {
      kind: "ready",
      cliPrefix: "'/Users/synthetic/Library/Application Support/cashU/bin/cashu' --profile anna",
      mcpAdd:
        "claude mcp add cashu-anna -- '/Users/synthetic/Library/Application Support/cashU/bin/cashu' mcp --profile anna",
    };
    for (const platform of [undefined, "darwin", "linux"])
      expect(setupAgentContext(MAC, "anna", platform)).toEqual(ready);
  });

  it("Windows: PowerShell lines, the MCP server through cmd", () => {
    expect(setupAgentContext(WINDOWS, "anna", "win32")).toEqual({
      kind: "ready",
      cliPrefix:
        '& "C:\\Users\\Synthetic User\\AppData\\Local\\cashU\\bin\\cashu.cmd" --profile anna',
      mcpAdd:
        'claude mcp add cashu-anna "--" cmd /d /c "C:\\Users\\Synthetic User\\AppData\\Local\\cashU\\bin\\cashu.cmd" mcp --profile anna',
    });
  });

  it("Windows: unavailable for a launcher path cmd.exe would misread", () => {
    const launcher = "C:\\Users\\Tom & Jerry\\AppData\\Local\\cashU\\bin\\cashu.cmd";
    expect(setupAgentContext({ ...WINDOWS, launcher }, "anna", "win32")).toEqual({
      kind: "unavailable",
      reason: "launcher_unquotable",
    });
  });

  it("unavailable without a ready host, a launcher, a server prefix or a profile", () => {
    const unavailable = { kind: "unavailable", reason: "launcher_unavailable" };
    expect(setupAgentContext({ availability: "unavailable" }, "anna", "win32")).toEqual(
      unavailable,
    );
    expect(setupAgentContext({ ...MAC, launcher: "" }, "anna", undefined)).toEqual(unavailable);
    expect(setupAgentContext({ ...MAC, mcpServerPrefix: "" }, "anna", undefined)).toEqual(
      unavailable,
    );
    expect(setupAgentContext(MAC, null, undefined)).toEqual(unavailable);
  });
});
