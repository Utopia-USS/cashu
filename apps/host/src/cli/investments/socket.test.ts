import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CliExecParams, HostFrame } from "@cashu/host-protocol";
import { connectHost } from "@cashu/node-host";
import { afterEach, expect, it } from "vitest";
import { startLocalHost } from "../../host.js";
import { cleanup, tempDir, testHostOptions } from "../../testing/harness.js";

afterEach(cleanup);

it("answers native investment inspection over a real socket and delegates remaining leaves", async () => {
  const cwd = tempDir();
  writeFileSync(join(cwd, "invalid.csv"), "synthetic,header\n");
  const dataDir = tempDir();
  const host = await startLocalHost({
    ...testHostOptions(dataDir),
    launcher: false,
    python: null,
  });
  const command = async (argv: string[]) => {
    const connection = await connectHost({ dataDir, role: "cli", build: "test" });
    try {
      const notes: { method: string; params: unknown }[] = [];
      const answer = new Promise<unknown>((resolve, reject) => {
        connection.onFrame((frame: HostFrame) => {
          if (frame.t === "note" && frame.id === 1)
            notes.push({ method: frame.method, params: frame.params });
          if (frame.t === "res" && frame.id === 1) {
            if (frame.outcome.ok) resolve(frame.outcome.result);
            else reject(new Error(frame.outcome.error.code));
          }
        });
      });
      const params: CliExecParams = {
        argv,
        cwd,
        env: { CASHU_LANG: "en" },
        tty: { stdin: false, stdout: false, stderr: false },
      };
      connection.send({ t: "req", id: 1, method: "cli.exec", params });
      return { result: await answer, notes };
    } finally {
      connection.close();
    }
  };
  try {
    const kinds = await command(["invest", "alerts", "kinds"]);
    expect(kinds.result).toEqual({ kind: "exit", code: 0 });
    expect(kinds.notes.some((note) => note.method === "cli.out")).toBe(true);
    const invalid = await command(["invest", "validate", "invalid.csv"]);
    expect(invalid.result).toEqual({ kind: "exit", code: 1 });
    expect(invalid.notes.some((note) => note.method === "cli.out")).toBe(true);
    const unported = await command(["invest", "run", "--offline"]);
    expect(unported.result).toEqual({ kind: "exit", code: 69 });
    expect(unported.notes.some((note) => note.method === "cli.out")).toBe(true);
  } finally {
    await host.stop();
  }
});
