// The hosted command tree's routing: ported commands get the raw arguments after their name and the
// root profile; root help and all unsupported inputs get native responses.
import { createTranslator } from "@cashu/i18n";
import { describe, expect, it } from "vitest";
import { type CommandIo, type PortedCommand, runTree } from "./tree.js";

const io: CommandIo = {
  cwd: "/tmp",
  env: {},
  tty: { stdin: false, stdout: false, stderr: false },
  signal: new AbortController().signal,
  t: createTranslator("en"),
  stdout: () => {},
  stderr: () => {},
  prompt: async () => null,
  stdin: async function* () {},
};

const seen: { args: readonly string[]; profile: string | undefined }[] = [];
const ported: PortedCommand[] = [
  {
    name: "sample",
    async run(args, _io, root) {
      seen.push({ args, profile: root.profile });
      return 7;
    },
  },
];

describe("runTree", () => {
  it.each([
    [["sample", "--data-dir", "/a", "--fold"], ["--data-dir", "/a", "--fold"], undefined],
    [["--profile", "x", "sample"], [], "x"],
    [["-px", "sample", "--", "a"], ["--", "a"], "x"],
    [["-p", "x", "sample", "--profile", "y"], ["--profile", "y"], "x"],
  ])("runs ported %j with its raw args", async (argv, args, profile) => {
    seen.length = 0;
    expect(await runTree(argv, io, ported)).toEqual({ kind: "exit", code: 7 });
    expect(seen).toEqual([{ args, profile }]);
  });

  it.each([
    [["stats"]],
    [[]],
    [["--help"]],
    [["-h"]],
    [["nonexistent", "x"]],
    [["--profile"]],
    [["--unknown-root-flag", "stats"]],
  ])("answers %j natively", async (argv) => {
    seen.length = 0;
    expect(await runTree(argv, io, ported)).toEqual({
      kind: "exit",
      code: argv[0] === "--help" || argv[0] === "-h" ? 0 : 2,
    });
    expect(seen).toEqual([]);
  });
});

it("prints native syntax for a nested investment command", async () => {
  const lines: string[] = [];
  const invest: PortedCommand = {
    name: "invest",
    async run() {
      throw new Error("help must not run the command");
    },
  };
  expect(
    await runTree(
      ["-p", "demo", "invest", "positions", "--help"],
      { ...io, stdout: (line) => lines.push(line) },
      [invest],
    ),
  ).toEqual({ kind: "exit", code: 0 });
  expect(lines.join("")).toContain("positions [--account GID]");
});

it("treats --help after the option terminator as positional command input", async () => {
  const seen: string[][] = [];
  const invest: PortedCommand = {
    name: "invest",
    async run(args) {
      seen.push([...args]);
      return 2;
    },
  };
  expect(await runTree(["invest", "search", "--", "--help"], io, [invest])).toEqual({
    kind: "exit",
    code: 2,
  });
  expect(seen).toEqual([["search", "--", "--help"]]);
});

it("turns an internal unhandled child into native usage", async () => {
  const group: PortedCommand = {
    name: "group",
    async run(args) {
      return args[0] === "native" ? 0 : { kind: "unhandled" };
    },
  };
  expect(await runTree(["group", "native"], io, [group])).toEqual({ kind: "exit", code: 0 });
  expect(await runTree(["group", "legacy", "--help"], io, [group])).toEqual({
    kind: "exit",
    code: 2,
  });
});

it("resolves a default once per command while explicit and child profiles keep precedence", async () => {
  const calls: string[] = [];
  const seen: { root: string | undefined; env: string | undefined; child: string | undefined }[] =
    [];
  const command: PortedCommand = {
    name: "test",
    async run(args, commandIo, root) {
      seen.push({
        root: root.profile,
        env: commandIo.env.CASHU_PROFILE,
        child: args[0] === "--profile" ? args[1] : undefined,
      });
      return 0;
    },
  };
  const fallback = () => {
    calls.push("resolve");
    return "oldest";
  };
  await runTree(["test"], io, [command], fallback);
  await runTree(["test", "--profile", "child"], io, [command], fallback);
  await runTree(["--profile", "root", "test"], io, [command], fallback);
  await runTree(["test"], { ...io, env: { CASHU_PROFILE: "configured" } }, [command], fallback);
  await runTree(["--help"], io, [command], fallback);
  expect(calls).toEqual(["resolve", "resolve"]);
  expect(seen).toEqual([
    { root: undefined, env: "oldest", child: undefined },
    { root: undefined, env: "oldest", child: "child" },
    { root: "root", env: undefined, child: undefined },
    { root: undefined, env: "configured", child: undefined },
  ]);
});
