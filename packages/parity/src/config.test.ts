import { describe, expect, it } from "vitest";
import { ConfigError, optionsFor, parseConfig } from "./config.ts";

describe("config", () => {
  it("layers built-ins, default and per-check overrides", () => {
    const cfg = parseConfig({
      default: { absTol: 1e-6 },
      checks: { "a.b": { relTol: 1e-3, decimal: "numeric" } },
    });
    expect(optionsFor(cfg, "x.y")).toEqual({ absTol: 1e-6, relTol: 1e-12, decimal: "exact" });
    expect(optionsFor(cfg, "a.b")).toEqual({ absTol: 1e-6, relTol: 1e-3, decimal: "numeric" });
  });

  it("empty config means the built-in defaults", () => {
    expect(optionsFor(parseConfig({}), "a")).toEqual({
      absTol: 1e-9,
      relTol: 1e-12,
      decimal: "exact",
    });
  });

  it.each([
    [{ tolerance: 1 }],
    [{ default: { absTol: -1 } }],
    [{ default: { absTol: "1e-9" } }],
    [{ default: { decimal: "loose" } }],
    [{ default: { abstol: 1 } }],
    [{ checks: { a: [] } }],
    [[]],
  ])("rejects %j", (raw) => {
    expect(() => parseConfig(raw)).toThrow(ConfigError);
  });
});
