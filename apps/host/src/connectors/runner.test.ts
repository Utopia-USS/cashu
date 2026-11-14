import { describe, expect, it } from "vitest";
import { denoGraphProblem } from "./runner.js";

const root = "/synthetic/connector";
const local = `file://${root}/connector.ts`;
const helper = `file://${root}/lib/helper.ts`;
const graph = (extra: Record<string, unknown> = {}) => ({
  roots: [local],
  modules: [
    {
      specifier: local,
      dependencies: [{ specifier: "./lib/helper.ts", code: { specifier: helper }, type: null }],
    },
    { specifier: helper },
    { specifier: "node:path" },
  ],
  redirects: {},
  npmPackages: {},
  ...extra,
});

describe("Deno module graph confinement", () => {
  it("accepts a graph that stays inside the snapshot", () => {
    expect(denoGraphProblem(graph(), root)).toBeNull();
    expect(denoGraphProblem({ modules: [] }, root)).toBeNull();
    expect(denoGraphProblem(graph({ npmPackages: [] }), root)).toBeNull();
    expect(
      denoGraphProblem({ modules: [{ specifier: local, dependencies: [[], { code: 0 }] }] }, root),
    ).toBeNull();
  });

  it("reports a module that failed to parse only when nothing is forbidden", () => {
    const broken = { modules: [{ specifier: local, error: "syntax" }] };
    expect(denoGraphProblem(broken, root)).toBe("module_parse_error");
    expect(
      denoGraphProblem({ modules: [...broken.modules, { specifier: "file:///etc/hosts" }] }, root),
    ).toBe("forbidden_import");
  });

  it.each([
    ["null", null],
    ["an array", [graph()]],
    ["no modules", { roots: [local] }],
    ["modules not an array", { modules: {} }],
    ["npm packages", graph({ npmPackages: ["left-pad"] })],
    ["null redirects", graph({ redirects: null })],
    ["array redirects", graph({ redirects: [local] })],
    ["a redirect out of the snapshot", graph({ redirects: { [local]: "file:///etc/hosts" } })],
    ["a __proto__ redirect", JSON.parse(`{"modules":[],"redirects":{"__proto__":"${local}"}}`)],
    ["a module without a specifier", { modules: [{ error: "x" }] }],
    ["a non-string specifier", { modules: [{ specifier: 7 }] }],
    ["a null module", { modules: [null] }],
    ["dependencies not an array", { modules: [{ specifier: local, dependencies: {} }] }],
    ["a null dependency", { modules: [{ specifier: local, dependencies: [null] }] }],
    [
      "a code target without a specifier",
      { modules: [{ specifier: local, dependencies: [{ code: { error: "x" } }] }] },
    ],
    ["a truthy primitive target", { modules: [{ specifier: local, dependencies: [{ type: 1 }] }] }],
    ["a remote module", { modules: [{ specifier: "https://example.test/mod.ts" }] }],
    ["a non-string root", graph({ roots: [1] })],
    ["a root outside the snapshot", graph({ roots: ["file:///synthetic/other.ts"] })],
  ])("refuses %s", (_label, value) => {
    expect(denoGraphProblem(value, root)).toBe("forbidden_import");
  });
});
