import { expect, it } from "vitest";
import { transferOptions } from "./categorizeTransfers.js";

it("parses the default and signed day gap with the last reset flag winning", () => {
  expect(transferOptions([])).toEqual({ reset: false, maxDays: 3 });
  expect(transferOptions(["--reset", "--max-days", "+7"])).toEqual({
    reset: true,
    maxDays: 7,
  });
  expect(transferOptions(["--reset", "--no-reset", "--max-days=-2", "--"])).toEqual({
    reset: false,
    maxDays: -2,
  });
  expect(transferOptions(["--max-days=1", "--max-days", "0"])).toEqual({
    reset: false,
    maxDays: 0,
  });
});

it("rejects missing, fractional, unsafe, and positional values before a write", () => {
  for (const args of [
    ["--max-days"],
    ["--max-days="],
    ["--max-days", "--reset"],
    ["--max-days=1.5"],
    ["--max-days=9007199254740992"],
    ["3"],
    ["--", "--reset"],
    ["--unknown"],
  ]) {
    expect(transferOptions(args)).toBeNull();
  }
});
