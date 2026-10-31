import { describe, expect, it } from "vitest";
import {
  isFromStoreProcess,
  isToStoreProcess,
  parseStoreProcessArgv,
  storeProcessArgv,
} from "./storeControl.js";

describe("store process control", () => {
  it("round-trips its arguments", () => {
    const argv = storeProcessArgv({ storeDir: "/lab/data/store", demo: true });
    expect(parseStoreProcessArgv(["node", "entry", ...argv])).toEqual({
      storeDir: "/lab/data/store",
      demo: true,
    });
    expect(parseStoreProcessArgv(["--store-dir"])).toBeNull();
    expect(parseStoreProcessArgv(["--store-dir", "--demo"])).toBeNull();
  });

  it("accepts only the known messages", () => {
    expect(isToStoreProcess({ t: "connect" })).toBe(true);
    expect(isToStoreProcess({ t: "sub" })).toBe(false);
    expect(isFromStoreProcess({ t: "ready", vaults: 2 })).toBe(true);
    expect(isFromStoreProcess({ t: "ready" })).toBe(false);
    expect(isFromStoreProcess({ t: "log", line: 3 })).toBe(false);
    expect(isFromStoreProcess(null)).toBe(false);
  });
});
