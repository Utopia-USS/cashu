// The hosted command tree's routing: ported commands get the raw arguments after their name and the
// root profile; Python commands, unknown commands, root help and root parse errors are delegated.
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
    name: "genesis",
    async run(args, _io, root) {
      seen.push({ args, profile: root.profile });
      return 7;
    },
  },
];
const delegated = { stats: "S39a", invest: "S39d" };

describe("runTree", () => {
  it.each([
    [["genesis", "--data-dir", "/a", "--fold"], ["--data-dir", "/a", "--fold"], undefined],
    [["--profile", "x", "genesis"], [], "x"],
    [["--profile=x", "genesis", "--help"], ["--help"], "x"],
    [["-px", "genesis", "--", "a"], ["--", "a"], "x"],
    [["-p", "x", "genesis", "--profile", "y"], ["--profile", "y"], "x"],
  ])("runs ported %j with its raw args", async (argv, args, profile) => {
    seen.length = 0;
    expect(await runTree(argv, io, ported, delegated)).toEqual({ kind: "exit", code: 7 });
    expect(seen).toEqual([{ args, profile }]);
  });

  it.each([
    [["stats"]],
    [["-p", "demo-anna", "invest", "positions", "--help"]],
    [[]],
    [["--help"]],
    [["-h"]],
    [["nonexistent", "x"]],
    [["--profile"]],
    [["--unknown-root-flag", "stats"]],
  ])("delegates %j", async (argv) => {
    seen.length = 0;
    expect(await runTree(argv, io, ported, delegated)).toEqual({ kind: "delegate" });
    expect(seen).toEqual([]);
  });
});
