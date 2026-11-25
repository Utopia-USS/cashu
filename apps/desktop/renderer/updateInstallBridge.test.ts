import { afterEach, describe, expect, it, vi } from "vitest";
import { parseManualUpdates, readManualUpdates } from "./updateInstallBridge.js";

afterEach(() => vi.unstubAllGlobals());

const manual = {
  kind: "manual",
  version: "0.6.0",
  releasesUrl: "https://github.com/Utopia-USS/cashu/releases/latest",
};

describe("update install method", () => {
  it("accepts main's manual-update answer with an https releases page", () => {
    expect(parseManualUpdates(manual)).toEqual({
      version: "0.6.0",
      releasesUrl: "https://github.com/Utopia-USS/cashu/releases/latest",
    });
  });

  it("treats an in-app updater and anything malformed as no manual updates", () => {
    expect(parseManualUpdates({ kind: "in_app" })).toBeNull();
    expect(parseManualUpdates(null)).toBeNull();
    expect(parseManualUpdates({ ...manual, extra: 1 })).toBeNull();
    expect(parseManualUpdates({ ...manual, version: "latest" })).toBeNull();
    for (const releasesUrl of [
      "http://github.com/Utopia-USS/cashu/releases",
      "file:///C:/cashU",
      "javascript:alert(1)",
      "https://user:pw@example.test/",
      "not a url",
    ])
      expect(parseManualUpdates({ ...manual, releasesUrl })).toBeNull();
  });

  it("asks main through the preload bridge and never throws", async () => {
    expect(await readManualUpdates()).toBeNull(); // no bridge: a browser or a story
    vi.stubGlobal("window", { cashuUpdates: { installMethod: async () => manual } });
    expect((await readManualUpdates())?.version).toBe("0.6.0");
    vi.stubGlobal("window", {
      cashuUpdates: {
        installMethod: async () => {
          throw new Error("synthetic failure");
        },
      },
    });
    expect(await readManualUpdates()).toBeNull();
  });
});
