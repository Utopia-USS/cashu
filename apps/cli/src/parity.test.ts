// Parity of the thin client with the Python app it fronts (oracle: the repo's .venv; skipped without
// Python). A demo data dir is made with scripts/demo_data.py in a temp dir (synthetic, never a real or
// lab path); each case runs once with the Python CLI directly and once through the shim (host started
// on demand, Python delegated) on fresh copies at the same path, and compares exit code, stdout and
// stderr byte for byte. The commands are those the shipped skills reference (.claude/skills): run for
// real where they stay local, as `--help` where they would reach the network, the keychain, a server
// or the OS (Enable Banking, LLM categorization, secrets, serve, launch agents). The MCP server's
// tool list must hash the same through the host's proxy, also after the host was killed.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDirs, tempDir } from "./testing/dirs.js";
import { cleanEnv, HAS_PYTHON, python } from "./testing/python.js";
import { hostPid, runShim, spawnShim, stopHosts } from "./testing/shim.js";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const PYTHON_CLI = join(REPO, ".venv/bin/cashu");
const SLOW = 60_000;

/** Commands the shipped skills reference; `--help` where running them would leave the machine. */
const CASES: readonly (readonly string[])[] = [
  ["--help"],
  ["accounts"],
  ["stats"],
  ["--profile", "demo-anna", "stats"],
  ["--profile", "demo-piotr", "accounts"],
  ["invest", "positions"],
  ["--profile", "demo-anna", "invest", "signals"],
  ["loans", "list"],
  ["connectors", "list"],
  ["connectors", "catalog", "list"],
  ["workspace", "path"],
  ["workspace", "init", "--profile", "demo-anna"],
  ["workspace", "update"],
  ["init-db"],
  ["profiles", "add", "Synthetic Test", "--modules", "budget"],
  ["profiles", "list"],
  ["match-transfers"],
  ["--profile", "demo-anna", "match-transfers"],
  ["import-dir", "inbox-empty"],
  ["--profile", "demo-anna", "loans", "set-payment"],
  ["nonexistent-command"],
  ["--profile", "no-such-profile", "accounts"],
  // network, keychain, servers, OS registration, LLM: help only (same text, nothing run)
  ...[
    ["connectors", "test"],
    ["connectors", "add"],
    ["connectors", "catalog", "add"],
    ["connectors", "secret", "set"],
    ["secrets", "set"],
    ["invest", "import"],
    ["invest", "validate"],
    ["invest", "run"],
    ["invest", "accounts", "add"],
    ["eb", "banks"],
    ["eb", "check"],
    ["eb", "resync"],
    ["eb", "login"],
    ["set-category"],
    ["serve"],
    ["migrate-data"],
    ["categorize"],
    ["loans", "add"],
    ["set-vehicle"],
    ["add-position"],
    ["mcp"],
  ].map((c) => [...c, "--help"]),
];

let golden = "";

function caseEnv(base: string): NodeJS.ProcessEnv {
  return {
    ...cleanEnv(),
    CASHU_DATA_DIR: join(base, "data"),
    CASHU_WORKSPACES_DIR: join(base, "ws"),
    CASHU_AUTO_DAILY: "0",
    CASHU_TESTING: "1",
    HOME: join(base, "home"),
  };
}

/** A fresh copy of the demo data dir (and empty workspaces / home / inbox) under `base`. */
function reset(base: string): void {
  for (const d of ["data", "ws", "home", "inbox-empty"])
    rmSync(join(base, d), { recursive: true, force: true });
  cpSync(golden, join(base, "data"), { recursive: true });
  for (const d of ["ws", "home", "inbox-empty"]) mkdirSync(join(base, d));
}

function direct(args: readonly string[], env: NodeJS.ProcessEnv, cwd: string) {
  const r = spawnSync(PYTHON_CLI, [...args], { env, cwd, encoding: "utf8", timeout: 50_000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe.skipIf(!HAS_PYTHON)("thin client parity with the Python app (oracle)", () => {
  beforeAll(() => {
    const base = tempDir("cashu-parity-golden-");
    golden = join(base, "data");
    const env = caseEnv(base);
    // Rule: the Python app must resolve the temp dir before anything runs.
    expect(python("from cashu.core import paths\nprint(paths.data_dir())", env).trim()).toBe(
      golden,
    );
    const r = spawnSync(
      join(REPO, ".venv/bin/python"),
      ["scripts/demo_data.py", "--data-dir", golden],
      {
        env,
        cwd: REPO,
        encoding: "utf8",
        timeout: 120_000,
      },
    );
    expect(r.status, r.stderr).toBe(0);
  }, 120_000);

  afterAll(async () => {
    await stopHosts();
    removeTempDirs();
  });

  describe.concurrent("skill commands give byte-identical output through the shim", () => {
    it.each(CASES.map((c) => [c.join(" "), c] as const))(
      "%s",
      async (_name, args) => {
        const base = tempDir("cashu-parity-");
        const env = caseEnv(base);
        reset(base);
        const want = direct(args, env, base);
        reset(base);
        const got = await runShim(args, env, { cwd: base });
        expect({ code: got.code, stdout: got.stdout, stderr: got.stderr }).toEqual(want);
      },
      SLOW,
    );
  });

  /** initialize + tools/list over a stdio MCP server process; returns the two results. */
  async function toolList(child: ReturnType<typeof spawn>, afterKill?: () => void) {
    const lines: Record<string, unknown>[] = [];
    const waiters: (() => void)[] = [];
    createInterface({ input: child.stdout as NodeJS.ReadableStream }).on("line", (l) => {
      lines.push(JSON.parse(l));
      for (const w of waiters.splice(0)) w();
    });
    const next = async (pred: (m: Record<string, unknown>) => boolean) => {
      for (;;) {
        const i = lines.findIndex(pred);
        if (i !== -1) return lines.splice(i, 1)[0] as Record<string, unknown>;
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
    };
    const send = (m: unknown) => child.stdin?.write(`${JSON.stringify(m)}\n`);
    send({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "t", version: "0" },
      },
    });
    const init = await next((m) => m.id === 0);
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const list = await next((m) => m.id === 1);
    let again: Record<string, unknown> | undefined;
    if (afterKill !== undefined) {
      afterKill();
      await next((m) => m.method === "notifications/tools/list_changed");
      send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      again = await next((m) => m.id === 2);
    }
    child.stdin?.end();
    await new Promise((resolve) => child.on("close", resolve));
    return { init, list, again };
  }

  const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

  it(
    "keeps the MCP tool list (names, schemas, annotations) through the host, also after a host restart",
    async () => {
      const base = tempDir("cashu-parity-mcp-");
      const env = caseEnv(base);
      reset(base);
      const py = spawn(PYTHON_CLI, ["mcp", "--profile", "demo-anna"], {
        env,
        cwd: base,
        stdio: "pipe",
      });
      const want = await toolList(py);
      reset(base);
      const shim = spawnShim(["mcp", "--profile", "demo-anna"], env, base);
      const got = await toolList(shim, () => {
        process.kill(hostPid(env.CASHU_DATA_DIR as string) as number, "SIGKILL");
      });
      expect((want.list.result as { tools: unknown[] }).tools.length).toBeGreaterThan(30);
      expect(hash(got.list.result)).toBe(hash(want.list.result));
      expect(hash(got.again?.result)).toBe(hash(want.list.result));
      // initialize: identical except the transport's tools.listChanged.
      const wantInit = structuredClone(want.init.result) as {
        capabilities: { tools: Record<string, unknown> };
      };
      wantInit.capabilities.tools.listChanged = true;
      expect(got.init.result).toEqual(wantInit);
    },
    SLOW,
  );

  it(
    "keeps the Python CLI's unknown-profile refusal for cashu mcp",
    async () => {
      const base = tempDir("cashu-parity-mcp-");
      const env = caseEnv(base);
      reset(base);
      const want = direct(["mcp", "--profile", "nobody"], env, base);
      reset(base);
      const got = await runShim(["mcp", "--profile", "nobody"], env, { cwd: base });
      expect({ code: got.code, stdout: got.stdout, stderr: got.stderr }).toEqual(want);
    },
    SLOW,
  );
});
