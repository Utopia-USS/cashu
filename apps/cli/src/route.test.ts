import { describe, expect, it } from "vitest";
import { route } from "./route.js";

describe("route", () => {
  it.each([
    [["mcp", "--profile", "demo-anna"], "demo-anna"],
    [["mcp", "-p", "demo-anna"], "demo-anna"],
    [["mcp", "--profile=demo-anna"], "demo-anna"],
    [["mcp", "-pdemo-anna"], "demo-anna"],
    [["--profile", "demo-anna", "mcp"], "demo-anna"],
    [["-p", "demo-anna", "mcp", "--profile", "demo-anna"], "demo-anna"],
  ])("serves %j as an MCP session", (argv, profile) => {
    expect(route(argv)).toEqual({ kind: "mcp", profile });
  });

  it.each([
    [["mcp"]],
    [["mcp", "--help"]],
    [["mcp", "--profile"]],
    [["mcp", "--profile", "a", "--extra"]],
    [["--profile", "a", "mcp", "--profile", "b"]],
    [["mcp", "--profile", "Demo-Anna"]],
    [["mcp", "mcp", "--profile", "a"]],
    [["stats"]],
    [[]],
    [["--help"]],
    [["host"]],
  ])("sends %j to the host as a command", (argv) => {
    expect(route(argv).kind).toBe(argv[0] === "host" ? "host-usage" : "cli");
  });

  it("knows its own host commands only in the exact shape", () => {
    expect(route(["host", "status"])).toEqual({ kind: "host", action: "status" });
    expect(route(["host", "stop"])).toEqual({ kind: "host", action: "stop" });
    expect(route(["host", "run"])).toEqual({ kind: "host", action: "run" });
    expect(route(["host", "status", "x"])).toEqual({ kind: "host-usage" });
    expect(route(["host", "restart"])).toEqual({ kind: "host-usage" });
    expect(route(["--profile", "a", "host", "status"])).toEqual({ kind: "cli" });
  });
});
