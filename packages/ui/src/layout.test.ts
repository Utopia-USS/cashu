import { describe, expect, it } from "vitest";
import { type Layout, layoutClass } from "./layout.js";

describe("layoutClass", () => {
  it("passes one class through and joins a list", () => {
    expect(layoutClass("grow")).toBe("grow");
    expect(layoutClass(["grow", "basis-0", "mt-2"])).toBe("grow basis-0 mt-2");
    expect(layoutClass(undefined)).toBe("");
  });

  it("rejects identity classes at compile time", () => {
    // @ts-expect-error a color is identity, not layout
    const color: Layout = "text-fg";
    // @ts-expect-error padding is identity (variants own it)
    const padding: Layout = "p-4";
    // @ts-expect-error off-scale step
    const offScale: Layout = "m-7";
    expect([color, padding, offScale]).toHaveLength(3);
  });
});
