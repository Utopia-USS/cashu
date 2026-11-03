// An explicit isolated synthetic host for Electron store-port tests. Ordinary desktop startup has no
// native vault provider until the production KeyStore factory is bound, so these tests never ask it
// to manufacture a demo vault.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface SyntheticHost {
  readonly child: ChildProcess;
  stop(): Promise<void>;
}

export async function startSyntheticHost(
  dataDir: string,
  killAfterCommits = 0,
): Promise<SyntheticHost> {
  const repo = process.env.E2E_REPO;
  if (repo === undefined) throw new Error("E2E_REPO missing");
  const home = mkdtempSync(join(tmpdir(), "cashu-e2e-host-home-"));
  const child = spawn(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--experimental-strip-types",
      "--import",
      join(repo, "tools", "node-ts", "resolveTs.ts"),
      join(repo, "apps", "host", "src", "testing", "faultHost.ts"),
      dataDir,
      home,
      String(killAfterCommits),
      "60000",
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
  let stopping: Promise<void> | undefined;
  const stop = () => {
    stopping ??= (async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      const force = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 3_000);
      try {
        await exited;
      } finally {
        clearTimeout(force);
        rmSync(home, { recursive: true, force: true });
      }
    })();
    return stopping;
  };
  try {
    await new Promise<void>((resolve, reject) => {
      let output = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes("ready")) resolve();
      });
      child.once("exit", (code) => reject(new Error(`synthetic host exited (${code})`)));
      child.once("error", reject);
    });
  } catch (error) {
    await stop();
    throw error;
  }
  return { child, stop };
}
