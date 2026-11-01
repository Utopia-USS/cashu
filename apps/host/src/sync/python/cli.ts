// TRANSITIONAL(S49): the host's outbox bridge (S31a spec 5.3), Python side.
//
// Python's side of the bridge runs through the `cashu` CLI only (Python stays the one writer of its
// schema): `sync ack`, `sync apply --stdin`, `sync seed`. Ack / seed inputs go through a 0600 file in
// the vault's state dir, deleted after. A non-zero exit fails the step (retried next iteration; the
// intent stays). Output lines carry counts only; stderr is never echoed (it may name a path). The
// child runs asynchronously: the host's event loop keeps serving its other sessions meanwhile.
import { spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Stdout kept from one child (the counts line is small; anything larger is a failure). */
const MAX_OUTPUT = 64 * 1024 * 1024;

class PythonCliError extends Error {
  readonly command: string;
  constructor(command: string, status: number | null) {
    super(`cashu ${command} failed (exit ${status ?? "signal"})`);
    this.name = "PythonCliError";
    this.command = command;
  }
}

export interface PythonCli {
  ack(through: number, entries: readonly object[], tmpDir: string): Promise<void>;
  /** Applies inbound events of one profile; resolves with the counts line. */
  apply(slug: string, lines: readonly string[]): Promise<Readonly<Record<string, unknown>>>;
  seed(
    slug: string,
    ids: readonly object[],
    tmpDir: string,
  ): Promise<Readonly<Record<string, unknown>>>;
}

/** A CLI runner over `argv` (the `cashu` command) with exactly `env` (the lab: a safe env). */
export function pythonCli(
  argv: readonly string[],
  env: Readonly<Record<string, string>>,
): PythonCli {
  const [cmd, ...base] = argv;
  if (cmd === undefined) throw new Error("python.argv is empty");
  const run = (name: string, args: readonly string[], input?: string) =>
    new Promise<string>((resolve, reject) => {
      const child = spawn(cmd, [...base, ...args], {
        env: { ...env },
        stdio: ["pipe", "pipe", "ignore"],
      });
      const out: Buffer[] = [];
      let size = 0;
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_OUTPUT) child.kill("SIGKILL");
        else out.push(chunk);
      });
      child.on("error", () => reject(new PythonCliError(name, null)));
      child.on("close", (code) => {
        if (code === 0 && size <= MAX_OUTPUT) resolve(Buffer.concat(out).toString("utf8"));
        else reject(new PythonCliError(name, code));
      });
      child.stdin.on("error", () => undefined); // a child that exits early closes its stdin
      child.stdin.end(input ?? "");
    });
  const withFile = async <T>(
    dir: string,
    name: string,
    rows: readonly object[],
    fn: (p: string) => Promise<T>,
  ): Promise<T> => {
    const path = join(dir, name);
    writeFileSync(path, rows.map((r) => `${JSON.stringify(r)}\n`).join(""), { mode: 0o600 });
    try {
      return await fn(path);
    } finally {
      rmSync(path, { force: true });
    }
  };
  const lastJson = (out: string): Record<string, unknown> => {
    const line = out.trim().split("\n").at(-1) ?? "{}";
    try {
      return JSON.parse(line) as Record<string, unknown>;
    } catch {
      return {};
    }
  };
  return {
    async ack(through, entries, tmpDir) {
      await withFile(tmpDir, "ack.jsonl", entries, (p) =>
        run("sync ack", ["sync", "ack", "--through", String(through), "--ids", p]),
      );
    },
    async apply(slug, lines) {
      const out = await run(
        "sync apply",
        ["--profile", slug, "sync", "apply", "--stdin"],
        `${lines.join("\n")}\n`,
      );
      return lastJson(out);
    },
    seed(slug, ids, tmpDir) {
      return withFile(tmpDir, "ids.jsonl", ids, async (p) =>
        lastJson(await run("sync seed", ["--profile", slug, "sync", "seed", "--ids", p])),
      );
    },
  };
}
