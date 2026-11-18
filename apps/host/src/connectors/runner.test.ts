import { describe, expect, it } from "vitest";
import { confinedProcess, denoGraphProblem, killConfined } from "./runner.js";

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

describe("confined process lifetime", () => {
  it("kills the process group on POSIX and the process itself on Windows", () => {
    const calls: [number, NodeJS.Signals][] = [];
    const kill = (pid: number, signal: NodeJS.Signals) => {
      calls.push([pid, signal]);
    };
    killConfined(4242, "darwin", kill);
    killConfined(4242, "linux", kill);
    killConfined(4242, "win32", kill);
    expect(calls).toEqual([
      [-4242, "SIGKILL"],
      [-4242, "SIGKILL"],
      [4242, "SIGKILL"],
    ]);
  });

  it("treats a process that already exited as killed", () => {
    expect(() =>
      killConfined(4242, "darwin", () => {
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      }),
    ).not.toThrow();
  });

  // The real Windows host: no sandbox there, so nothing is spawned at all.
  it.runIf(process.platform === "win32")("spawns nothing on Windows", async () => {
    const result = await confinedProcess(["x"], "(version 1)", ".", Buffer.alloc(0), 1000);
    expect(result).toMatchObject({ code: null, overflow: false, timedOut: false });
    expect(result.stdout.length).toBe(0);
  });
});
