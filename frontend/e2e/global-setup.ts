// Seeds a temp data dir with the demo data, starts the server, exports its URLs to the specs
// (E2E_BASE_URL, E2E_TOKEN) and returns the teardown (stop the server, remove the temp dirs).
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const PYTHON = join(REPO, ".venv", "bin", "python");
const WEBDIST = join(REPO, "src", "cashu", "api", "webdist", "index.html");

function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const srv = createServer();
    srv.once("error", fail);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => ok(port));
    });
  });
}

function waitForToken(proc: ChildProcess, log: string[]): Promise<string> {
  return new Promise((ok, fail) => {
    const timer = setTimeout(() => fail(new Error(`cashu serve printed no #token= URL in 60 s:\n${log.join("")}`)), 60_000);
    const onData = (chunk: Buffer) => {
      log.push(chunk.toString());
      const m = log.join("").replace(/\s+/g, "").match(/#token=([A-Za-z0-9_-]{20,})/);
      if (m) { clearTimeout(timer); ok(m[1]); }
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", (c: Buffer) => log.push(c.toString()));
    proc.once("exit", (code: number | null) => { clearTimeout(timer); fail(new Error(`cashu serve exited (${code}):\n${log.join("")}`)); });
  });
}

async function waitForHttp(url: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server at ${url} did not answer`);
}

export default async function globalSetup() {
  if (!existsSync(WEBDIST)) {
    throw new Error(`No built SPA at ${WEBDIST}. Run \`npm run build\` in frontend/ first (the e2e suite never builds).`);
  }
  if (!existsSync(PYTHON)) throw new Error(`No virtualenv at ${PYTHON} (python3 -m venv .venv && pip install -e ".[dev]").`);

  const root = mkdtempSync(join(tmpdir(), "cashu-e2e-"));
  // Fail-safe isolation, also for the specs' own CLI calls (process.env reaches the workers): HOME,
  // the data dirs, workspaces and launch agents point into the temp root, CASHU_TESTING=1 turns on
  // the guard of core/migrate_legacy.py (never acts under the real home folder), and every
  // pre-rename FINANSE_* variable (legacy name) is dropped.
  for (const key of Object.keys(process.env)) if (key.startsWith("FINANSE_")) delete process.env[key];
  mkdirSync(join(root, "home"));
  const isolation = {
    CASHU_TESTING: "1",
    HOME: join(root, "home"),
    CASHU_DATA_DIR: join(root, "data"),
    CASHU_LEGACY_DATA_DIR: join(root, "legacy-default-data-dir"),
    CASHU_WORKSPACES_DIR: join(root, "workspaces"),
    CASHU_LAUNCH_AGENTS_DIR: join(root, "LaunchAgents"),
    CASHU_APP_BUNDLE: "none",
  };
  Object.assign(process.env, isolation);
  delete process.env.CASHU_DATABASE_URL;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...isolation,
    CASHU_DEV_EMBED_TOKEN: "",
    PYTHONUNBUFFERED: "1",
    // Connector secrets typed in the e2e app stay in the server's memory, never in the macOS keychain.
    PYTHON_KEYRING_BACKEND: "memory_keyring.MemoryKeyring",
    PYTHONPATH: [HERE, process.env.PYTHONPATH].filter(Boolean).join(":"),
  };
  delete env.CASHU_DATABASE_URL;

  const seed = spawnSync(PYTHON, [join(REPO, "scripts", "demo_data.py"), "--data-dir", env.CASHU_DATA_DIR!], { env, encoding: "utf-8" });
  if (seed.status !== 0) throw new Error(`demo_data.py failed:\n${seed.stdout}\n${seed.stderr}`);

  const port = await freePort();
  const proc = spawn(PYTHON, [join(HERE, "serve_offline.py"), "--port", String(port)], {
    env: { ...env, COLUMNS: "400" }, stdio: ["ignore", "pipe", "pipe"],
  });
  const log: string[] = [];
  const token = await waitForToken(proc, log);
  const base = `http://127.0.0.1:${port}`;
  await waitForHttp(`${base}/`);

  process.env.E2E_BASE_URL = base;
  process.env.E2E_TOKEN = token;
  process.env.E2E_DATA_DIR = env.CASHU_DATA_DIR;
  // The specs' own CLI calls (18-connectors `cli()`) use the same memory keyring as the server, never the login keychain.
  process.env.E2E_PYTHON_KEYRING_BACKEND = env.PYTHON_KEYRING_BACKEND;
  process.env.E2E_PYTHONPATH = env.PYTHONPATH;

  return async () => {
    proc.kill("SIGINT");
    await new Promise((r) => { proc.once("exit", r); setTimeout(r, 5000); });
    if (proc.exitCode === null) proc.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  };
}
