// TRANSITIONAL(S49): the lab / dev host of the outbox bridge (S31a spec 5.3).
//
// Python's side of the bridge runs through the `cashu` CLI only (Python stays the one writer of its
// schema): `sync ack`, `sync apply --stdin`, `sync seed`. Ack / seed inputs go through a 0600 file in
// the vault's state dir, deleted after. A non-zero exit fails the step (retried next iteration; the
// intent stays). Output lines carry counts only; stderr is never echoed (it may name a path).
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

class PythonCliError extends Error {
  readonly command: string;
  constructor(command: string, status: number | null) {
    super(`cashu ${command} failed (exit ${status ?? "signal"})`);
    this.name = "PythonCliError";
    this.command = command;
  }
}

export interface PythonCli {
  ack(through: number, entries: readonly object[], tmpDir: string): void;
  /** Applies inbound events of one profile; returns the counts line. */
  apply(slug: string, lines: readonly string[]): Readonly<Record<string, unknown>>;
  seed(slug: string, ids: readonly object[], tmpDir: string): Readonly<Record<string, unknown>>;
}

/** A CLI runner over `argv` (the `cashu` command) with exactly `env` (the lab: a safe env). */
export function pythonCli(
  argv: readonly string[],
  env: Readonly<Record<string, string>>,
): PythonCli {
  const [cmd, ...base] = argv;
  if (cmd === undefined) throw new Error("python.argv is empty");
  const run = (name: string, args: readonly string[], input?: string) => {
    const r = spawnSync(cmd, [...base, ...args], {
      env: { ...env },
      input,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    if (r.status !== 0) throw new PythonCliError(name, r.status);
    return r.stdout;
  };
  const withFile = <T>(
    dir: string,
    name: string,
    rows: readonly object[],
    fn: (p: string) => T,
  ) => {
    const path = join(dir, name);
    writeFileSync(path, rows.map((r) => `${JSON.stringify(r)}\n`).join(""), { mode: 0o600 });
    try {
      return fn(path);
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
    ack(through, entries, tmpDir) {
      withFile(tmpDir, "ack.jsonl", entries, (p) =>
        run("sync ack", ["sync", "ack", "--through", String(through), "--ids", p]),
      );
    },
    apply(slug, lines) {
      const out = run(
        "sync apply",
        ["--profile", slug, "sync", "apply", "--stdin"],
        `${lines.join("\n")}\n`,
      );
      return lastJson(out);
    },
    seed(slug, ids, tmpDir) {
      return withFile(tmpDir, "ids.jsonl", ids, (p) =>
        lastJson(run("sync seed", ["--profile", slug, "sync", "seed", "--ids", p])),
      );
    },
  };
}
