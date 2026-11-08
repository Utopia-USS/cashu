import { describe, expect, it } from "vitest";
import { heroValueParts } from "./homeModel.js";

describe("heroValueParts", () => {
  const join = (p: ReturnType<typeof heroValueParts>) =>
    p ? `${p.pre}${p.main}${p.fraction}${p.post}` : null;

  it("splits a Polish amount: whole part, dimmed decimals, currency after", () => {
    const text = "61 789,61 zł";
    const parts = heroValueParts(text);
    expect(parts).toEqual({ pre: "", main: "61 789", fraction: ",61", post: " zł" });
    expect(join(parts)).toBe(text);
  });

  it("splits an English amount with the currency before it", () => {
    const parts = heroValueParts("PLN 61,789.61");
    expect(parts).toEqual({ pre: "PLN ", main: "61,789", fraction: ".61", post: "" });
  });

  it("keeps a masked amount whole", () => {
    expect(heroValueParts("•• ••• zł")).toBeNull();
  });
});
