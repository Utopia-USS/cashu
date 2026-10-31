import { describe, expect, it } from "vitest";
import { findMarkers, formatMarkers } from "./transitional.ts";

describe("TRANSITIONAL( markers (report, never a failure)", () => {
  it("finds markers with their removing scope", () => {
    const src = "// TRANSITIONAL(S30): Python bridge until the store owns writes\nconst x = 1;";
    const markers = findMarkers("a.ts", src);
    expect(markers).toEqual([
      { file: "a.ts", line: 1, scope: "S30", text: "Python bridge until the store owns writes" },
    ]);
    expect(formatMarkers(markers)).toContain("S30 (1)");
  });
});
