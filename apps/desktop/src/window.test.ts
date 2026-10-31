import { describe, expect, it } from "vitest";
import { MIN_SIZE } from "./config.js";
import { windowSize } from "./window.js";

describe("window size (shell.window_size)", () => {
  it("uses the default size without screen info", () => {
    expect(windowSize()).toEqual({ width: 1480, height: 940 });
  });

  it("shrinks to the main screen but never below the minimum", () => {
    expect(windowSize([{ width: 1440, height: 900 }])).toEqual({ width: 1360, height: 820 });
    expect(windowSize([{ width: 800, height: 600 }])).toEqual({
      width: MIN_SIZE.width,
      height: MIN_SIZE.height,
    });
    expect(windowSize([{ width: 3840, height: 2160 }])).toEqual({ width: 1480, height: 940 });
  });
});
