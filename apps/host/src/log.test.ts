import { describe, expect, it } from "vitest";
import { errorName, errorShortCode, formatLine, memoryLog } from "./log.js";

describe("host log", () => {
  it("keeps codes and counts and replaces anything that is not a code", () => {
    const line = JSON.parse(
      formatLine(new Date(0), "info", "store.command.failed", {
        command: "core.renameProfile",
        count: 3,
        flag: true,
        name: "Jan Kowalski",
        amount: "1 234,56 zł",
        bad: Number.NaN,
        "not a key": 1,
      }),
    );
    expect(line).toEqual({
      at: "1970-01-01T00:00:00.000Z",
      level: "info",
      event: "store.command.failed",
      command: "core.renameProfile",
      count: 3,
      flag: true,
      name: "?",
      amount: "?",
      bad: null,
    });
  });

  it("logs errors by class name only", () => {
    const log = memoryLog();
    log.warn("x", { error: errorName(new TypeError("value 42 PLN is wrong")) });
    expect(log.lines[0]).toContain('"error":"TypeError"');
    expect(log.lines[0]).not.toContain("42");
  });

  it("names an error's short code: Node / system codes, cashU codes, never a message", () => {
    const sqlite = Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR" });
    expect(errorShortCode(sqlite)).toBe("ERR_SQLITE_ERROR");
    expect(errorShortCode(Object.assign(new Error("x"), { code: "EBUSY" }))).toBe("EBUSY");
    expect(errorShortCode(new Error("native_session_unavailable"))).toBe(
      "native_session_unavailable",
    );
    expect(errorShortCode(new Error("value 42 PLN is wrong"))).toBe("?");
    expect(errorShortCode(Object.assign(new Error("x"), { code: "Not A Code 42" }))).toBe("?");
    expect(errorShortCode("thrown string")).toBe("?");
  });
});
