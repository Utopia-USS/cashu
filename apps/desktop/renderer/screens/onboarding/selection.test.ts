import { builtinRegistry, createCoreRegistry, moduleSpec } from "@cashu/domain/core";
import { describe, expect, it } from "vitest";
import { toggleModuleSelection } from "./selection.js";

describe("Wizard module selection", () => {
  const registry = builtinRegistry();

  it("allows zero modules and follows declared dependencies in registry order", () => {
    const dependent = createCoreRegistry([
      moduleSpec({ id: "budget", name: "Budget", description: "Synthetic" }),
      moduleSpec({ id: "loans", name: "Loans", description: "Synthetic", dependsOn: ["budget"] }),
    ]);
    const selected = toggleModuleSelection(dependent, [], "loans");
    expect(selected).toEqual(["budget", "loans"]);
    expect(toggleModuleSelection(dependent, selected, "budget")).toEqual([]);
    expect(toggleModuleSelection(registry, [], "loans")).toEqual(["loans"]);
  });

  it("does not select an unavailable or unknown module", () => {
    expect(toggleModuleSelection(registry, [], "not-registered")).toEqual([]);
  });
});
