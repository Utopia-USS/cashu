import { describe, expect, it } from "vitest";
import {
  deadMarkers,
  findMarkers,
  formatMarkers,
  type ScopeRegistry,
  scopeRegistry,
  transitionalMarkers,
} from "./transitional.ts";

const REGISTRY: ScopeRegistry = {
  live: { S30: "planned: Python bridge", "S29c-B3": "queued: batch API" },
  external: { "xcode-27": "Xcode 27 on the build machine" },
};

describe("TRANSITIONAL( markers", () => {
  it("finds markers with their removing scope", () => {
    const src = "// TRANSITIONAL(S30): Python bridge until the store owns writes\nconst x = 1;";
    const markers = findMarkers("a.ts", src);
    expect(markers).toEqual([
      { file: "a.ts", line: 1, scope: "S30", text: "Python bridge until the store owns writes" },
    ]);
    expect(formatMarkers(markers)).toContain("S30 (1)");
  });

  it("finds Python and patch markers", () => {
    expect(findMarkers("a.py", "x = 1  # TRANSITIONAL(S30)")[0]?.scope).toBe("S30");
    expect(findMarkers("p.patch", "+// TRANSITIONAL(xcode-27): Swift 6.2")[0]?.scope).toBe(
      "xcode-27",
    );
  });

  it("accepts live scopes and external conditions", () => {
    const src = [
      "// TRANSITIONAL(S30): a",
      "// TRANSITIONAL(S29c-B3): b",
      "# TRANSITIONAL(xcode-27): c",
    ].join("\n");
    expect(deadMarkers(findMarkers("a.ts", src), REGISTRY)).toEqual([]);
  });

  it("flags a planted marker whose scope is done, dropped or unknown", () => {
    const src = [
      "// TRANSITIONAL(S29): done scope",
      "// TRANSITIONAL(S36): dropped scope",
      "// TRANSITIONAL(desktop-renderer): no scope id",
      "// TRANSITIONAL(s30): ids are case-sensitive",
    ].join("\n");
    const dead = deadMarkers(findMarkers("planted.ts", src), REGISTRY);
    expect(dead.map((m) => m.scope)).toEqual(["S29", "S36", "desktop-renderer", "s30"]);
    expect(formatMarkers(dead, REGISTRY)).toContain("S29 (1)  NOT LIVE in tools/arch/scopes.json");
  });

  it("does not treat the documented syntax as a marker", () => {
    expect(findMarkers("a.md", "mark it `TRANSITIONAL(<scope that removes it>)`")).toEqual([]);
  });
});

describe("live scope registry (tools/arch/scopes.json)", () => {
  const registry = scopeRegistry();

  it("is well formed: unique, non-empty ids with a status note", () => {
    const live = Object.keys(registry.live);
    const external = Object.keys(registry.external);
    expect(live.length).toBeGreaterThan(0);
    expect(live.filter((id) => external.includes(id))).toEqual([]);
    for (const [id, note] of Object.entries(registry.live)) {
      expect(id).toMatch(/^(S\d{2}[a-z]?[\w-]*|T\d+)$/);
      expect(note).toMatch(/^(in flight|queued|planned|hold): \S/);
    }
    for (const note of Object.values(registry.external)) expect(note.length).toBeGreaterThan(10);
  });

  it("every TRANSITIONAL marker in the repo names a live scope or an external condition", () => {
    const dead = deadMarkers(transitionalMarkers(), registry).map(
      (m) => `${m.file}:${m.line}  TRANSITIONAL(${m.scope})`,
    );
    expect(
      dead,
      "re-point the marker to the live scope that removes it, or remove the code (tools/arch/scopes.json)",
    ).toEqual([]);
  });
});
