// Drives the real host through the public shim. Logs include startup's automatic sync turn,
// which may drain the outbox before `bridge run --once` reaches its own serialized turn.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type HostLine = Record<string, unknown>;

export class HarnessHost {
  readonly #repo: string;
  readonly #data: string;
  readonly #nodeArgs: readonly string[];
  readonly #env: NodeJS.ProcessEnv;
  #offset = 0;

  constructor(repo: string, run: string, nodeArgs: readonly string[]) {
    this.#repo = repo;
    this.#data = join(run, "data");
    this.#nodeArgs = nodeArgs;
    this.#env = {
      PATH: process.env.PATH ?? "",
      HOME: homedir(),
      CASHU_DATA_DIR: this.#data,
    };
  }

  #shim(args: readonly string[]) {
    return spawnSync(
      process.execPath,
      [...this.#nodeArgs, join(this.#repo, "apps/cli/src/index.ts"), ...args],
      {
        cwd: this.#repo,
        env: this.#env,
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
        timeout: 120_000,
      },
    );
  }

  stop(): void {
    const result = this.#shim(["host", "stop"]);
    if (result.status !== 0) throw new Error("harness host stop failed");
  }

  #lines(): HostLine[] {
    let text: string;
    try {
      text = readFileSync(join(this.#data, "logs/host.log"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    // A milestone log is small. Refuse lost coverage if a future scenario reaches log rotation.
    if (text.length < this.#offset) throw new Error("harness host log rotated");
    const fresh = text.slice(this.#offset);
    this.#offset = text.length;
    return fresh
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line) as HostLine)
      .filter((line) => typeof line.event === "string" && line.event.startsWith("sync."))
      .map(({ at: _at, level: _level, event, point, ...fields }) =>
        event === "sync.progress"
          ? { progress: point }
          : { ...fields, step: String(event).slice("sync.".length) },
      );
  }

  run(args: readonly string[]): HostLine[] {
    const result = this.#shim(["bridge", ...args]);
    // The bridge state has an exclusive writer. Every direct harness read is after a clean stop;
    // a clean recovery also clears the crash streak before the next injected crash.
    this.stop();
    const lines = this.#lines();
    if (result.status !== 0)
      throw new Error(`harness bridge failed (${result.status ?? "signal"})`);
    return lines;
  }

  /** A real host, with the existing crash hook firing exactly at the durable boundary. */
  async killAt(point: string): Promise<HostLine[]> {
    const child = spawn(
      process.execPath,
      [
        ...this.#nodeArgs,
        join(this.#repo, "apps/host/src/sync/harness/crashHost.ts"),
        this.#data,
        homedir(),
        point,
      ],
      { cwd: this.#repo, env: this.#env, stdio: "ignore" },
    );
    const signal = await new Promise<NodeJS.Signals | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("harness crash point timed out"));
      }, 120_000);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (_code, signal) => {
        clearTimeout(timer);
        resolve(signal);
      });
    });
    const lines = this.#lines();
    if (signal !== "SIGKILL" || !lines.some((line) => line.progress === point)) {
      throw new Error("harness host did not crash at the requested boundary");
    }
    return lines;
  }
}
