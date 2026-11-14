import { describe, expect, it } from "vitest";
import {
  CLI_ENV_KEYS,
  cliExecParamsSchema,
  cliExecResultSchema,
  cliStdinParamsSchema,
} from "./cli.js";
import { mcpOpenParamsSchema } from "./mcp.js";

const exec = {
  argv: ["--profile", "demo-anna", "stats"],
  cwd: "/tmp/work",
  paths: { home: "/caller/home" },
  env: { CASHU_LANG: "pl", NO_COLOR: "1" },
  tty: { stdin: true, stdout: false, stderr: true, columns: 120 },
};

describe("cli.exec", () => {
  it("accepts the shim's request and the exit reply only", () => {
    expect(cliExecParamsSchema.parse(exec)).toEqual(exec);
    expect(cliExecResultSchema.parse({ kind: "exit", code: 3 })).toEqual({ kind: "exit", code: 3 });
    // The host runs every command natively: there is no reply that hands the shim another binary.
    const delegate = { kind: "delegate", command: "/repo/.venv/bin/cashu", args: [] };
    expect(cliExecResultSchema.safeParse(delegate).success).toBe(false);
  });

  it("forwards only the listed environment variables", () => {
    for (const key of [
      "CASHU_DATA_DIR",
      "FINANSE_DATA_DIR",
      "NO_COLOR",
      "LANG",
      "LC_ALL",
      "TERM",
    ]) {
      expect(CLI_ENV_KEYS.test(key)).toBe(true);
    }
    for (const key of ["HOME", "PATH", "ANTHROPIC_API_KEY", "cashu_data_dir", "CASHU_"]) {
      expect(CLI_ENV_KEYS.test(key)).toBe(false);
    }
    expect(cliExecParamsSchema.safeParse({ ...exec, env: { PATH: "/bin" } }).success).toBe(false);
    expect(mcpOpenParamsSchema.safeParse({ cwd: "/w", env: { HOME: "/h" } }).success).toBe(false);
  });

  it("refuses relative paths and out-of-range codes", () => {
    expect(cliExecParamsSchema.safeParse({ ...exec, cwd: "work" }).success).toBe(false);
    expect(mcpOpenParamsSchema.safeParse({ cwd: "work", env: {} }).success).toBe(false);
    expect(cliExecResultSchema.safeParse({ kind: "exit", code: 256 }).success).toBe(false);
  });

  it("carries stdin as bounded base64 chunks", () => {
    expect(cliStdinParamsSchema.parse({ exec: 1, data: "aGk=", eof: false }).data).toBe("aGk=");
    expect(
      cliStdinParamsSchema.safeParse({ exec: 1, data: "not base64!", eof: true }).success,
    ).toBe(false);
  });
});

it("requires the caller path context and carries terminal context without forwarding HOME", () => {
  const { paths: _paths, ...withoutPaths } = exec;
  expect(cliExecParamsSchema.safeParse(withoutPaths).success).toBe(false);
  const paths = { home: "/caller/home" };
  expect(cliExecParamsSchema.parse({ ...exec, paths }).paths).toEqual(paths);
  expect(cliExecParamsSchema.parse({ ...exec, paths: { home: "" } }).paths.home).toBe("");
  expect(cliExecParamsSchema.safeParse({ ...exec, paths: { home: "bad\u0000path" } }).success).toBe(
    false,
  );
  expect(cliExecParamsSchema.safeParse({ ...exec, env: { HOME: "/caller/home" } }).success).toBe(
    false,
  );
  const tty = { ...exec.tty, compatible: false };
  expect(cliExecParamsSchema.parse({ ...exec, tty }).tty).toEqual(tty);
});
