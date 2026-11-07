/// <reference types="node" />
// The start-up recovery screen (T54) in the real Electron window, without any host: a spawn-denying
// bootstrap (host-spawn-guard.cjs) runs before main. Python data in the data dir shows
// python_data_present from main's own admission; a host start that records a typed failure shows that
// code. The copied prompt must hold codes, `~` paths and the shipped command only. One spec runs
// "Import my data" for real on synthetic Python data (the guard swaps in the test-keychain migrate
// child): the retired Python app's launchd plists in the harness's temp agents dir go, nothing else.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { expect, launchGuardedDesktop, test } from "../electron-test.ts";

test.use({ trace: "off", screenshot: "off", video: "off" });

const HOSTILE = "PL61109010140000071219812874 Zofia Synthetic-Kowalska 12345.67";

interface Harness {
  readonly root: string;
  readonly home: string;
  readonly dataDir: string;
  launch(env?: Record<string, string>): Promise<ElectronApplication>;
  cleanup(): Promise<void>;
}

/**
 * `recovery`: D is `~/cashU-data` (the `~` paths of the report). `import`: the layout the test key
 * store accepts (`<tmp>/t44-test-<id>/data`, HOME beside it), for a real import with no OS keychain.
 */
function harness(layout: "recovery" | "import" = "recovery"): Harness {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), layout === "import" ? "t44-test-" : "cashu-recovery-e2e-")),
  );
  const home = join(root, "home");
  const dataDir = layout === "import" ? join(root, "data") : join(home, "cashU-data");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const apps: ElectronApplication[] = [];
  return {
    root,
    home,
    dataDir,
    async launch(env = {}) {
      const app = await launchGuardedDesktop({
        dataDir,
        env: {
          HOME: home,
          CASHU_TESTING: "1",
          CASHU_LEGACY_DATA_DIR: join(root, "legacy"),
          CASHU_WORKSPACES_DIR: join(root, "workspaces"),
          CASHU_LAUNCH_AGENTS_DIR: join(root, "LaunchAgents"),
          CASHU_DESKTOP_ALLOWED_DATA_ROOT: root,
          ...env,
        },
      });
      apps.push(app);
      // Capture what Copy writes instead of touching the system clipboard.
      await app.evaluate(({ clipboard }) => {
        const copied: string[] = [];
        (globalThis as { __copied?: string[] }).__copied = copied;
        clipboard.writeText = async (text: string) => {
          copied.push(text);
        };
      });
      return app;
    },
    async cleanup() {
      for (const app of apps.reverse()) await app.close().catch(() => {});
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function recoveryWindow(app: ElectronApplication): Promise<Page> {
  const page = await app.firstWindow();
  await page.waitForURL(/^app:\/\/cashu\/assets\/desktop\/index\.html\?recovery=1$/, {
    timeout: 90_000,
  });
  await expect(page.getByRole("heading", { name: "cashU nie może się uruchomić" })).toBeVisible();
  return page;
}

async function copiedPrompt(app: ElectronApplication, page: Page): Promise<string> {
  await page.getByRole("button", { name: "Kopiuj prompt dla agenta" }).click();
  await expect(page.getByText("Skopiowano prompt.")).toBeVisible();
  const copied = await app.evaluate(() => (globalThis as { __copied?: string[] }).__copied ?? []);
  expect(copied).toHaveLength(1);
  return copied[0] ?? "";
}

function assertPrivate(prompt: string, h: Harness): void {
  for (const value of [h.root, h.home, "PL61109010140000071219812874", "Zofia", "12345.67"])
    expect(prompt).not.toContain(value);
  expect(prompt).not.toContain("—");
}

function reportPair(dataDir: string): string[] {
  const dir = join(dataDir, "diagnostics");
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  const files = readdirSync(dir).filter((name) => /^startup-failure-.+\.(json|txt)$/.test(name));
  for (const file of files) expect(statSync(join(dir, file)).mode & 0o777).toBe(0o600);
  return files.sort();
}

test("Python data shows python_data_present with Import, Copy and no host or store", async () => {
  const h = harness();
  try {
    writeFileSync(join(h.dataDir, "cashu.db"), "synthetic sentinel", { mode: 0o600 });
    const app = await h.launch();
    const page = await recoveryWindow(app);
    await expect(page.getByRole("alert")).toContainText("dane z poprzedniej wersji cashU");
    await expect(page.getByTestId("recovery-code")).toHaveText("python_data_present");
    await expect(page.getByTestId("recovery-data-dir")).toHaveText("~/cashU-data");
    await expect(page.getByRole("button", { name: "Zaimportuj moje dane" })).toBeVisible();
    await expect(page.getByTestId("native-creation")).toHaveCount(0);

    const prompt = await copiedPrompt(app, page);
    expect(prompt).toContain("Kod błędu: python_data_present");
    expect(prompt).toContain("Folder danych: ~/cashU-data");
    expect(prompt).toContain("  pnpm cashu-next migrate\n");
    expect(prompt).toContain("  pnpm cashu-next migrate verify\n");
    expect(prompt).toContain("docs/migration-runbook.md");
    assertPrivate(prompt, h);

    const files = reportPair(h.dataDir);
    expect(files).toHaveLength(2);
    const text = files.find((name) => name.endsWith(".txt")) ?? "";
    expect(readFileSync(join(h.dataDir, "diagnostics", text), "utf8")).toBe(prompt);
    expect(existsSync(join(h.dataDir, "stores"))).toBe(false);
    expect(existsSync(join(h.dataDir, "test-spawns"))).toBe(false);

    // Retry with the Python data still there keeps the same screen and report.
    await page.getByRole("button", { name: "Spróbuj ponownie" }).click();
    await recoveryWindow(app);
    expect(reportPair(h.dataDir)).toEqual(files);
  } finally {
    await h.cleanup();
  }
});

test("a host start that records vault_key_unavailable shows that code and a redacted prompt", async () => {
  const h = harness();
  try {
    const failure = {
      code: "vault_key_unavailable",
      stage: "vault_open",
      detail: "keystore_unavailable",
      originalsUntouched: true,
      facts: { vaults: 1 },
    };
    const app = await h.launch({
      E2E_RECOVERY_FAILURE: JSON.stringify(failure),
      E2E_RECOVERY_HOSTILE: HOSTILE,
    });
    const page = await recoveryWindow(app);
    await expect(page.getByTestId("recovery-code")).toHaveText("vault_key_unavailable");
    await expect(page.getByRole("alert")).toContainText("Klucz, którym zaszyfrowany jest profil");
    await expect(page.getByRole("button", { name: "Zaimportuj moje dane" })).toHaveCount(0);

    const prompt = await copiedPrompt(app, page);
    expect(prompt).toContain("Kod błędu: vault_key_unavailable");
    expect(prompt).toContain("Szczegół: keystore_unavailable");
    expect(prompt).toContain("Etap: vault_open");
    expect(prompt).toContain("vaults=1");
    expect(prompt).toContain(
      "host.start-failure code=vault_key_unavailable detail=keystore_unavailable",
    );
    expect(prompt).toContain("  pnpm cashu-next migrate verify\n");
    assertPrivate(prompt, h);
    expect(readFileSync(join(h.dataDir, "test-spawns"), "utf8")).toMatch(/^(?:host\n)+$/);
    expect(reportPair(h.dataDir)).toHaveLength(2);
  } finally {
    await h.cleanup();
  }
});

test("Import my data retires the Python worker agents and shows the MCP lines to re-add", async () => {
  test.setTimeout(180_000);
  const h = harness("import");
  try {
    const repo = process.env.E2E_REPO;
    if (repo === undefined) throw new Error("E2E_REPO missing");
    const seed = spawnSync(
      process.execPath,
      [
        "--import",
        join(repo, "tools", "node-ts", "resolveTs.ts"),
        join(repo, "apps", "host", "src", "testing", "seedPythonData.ts"),
        h.dataDir,
      ],
      { env: { ...process.env, CASHU_TESTING: "1" }, encoding: "utf8" },
    );
    expect(seed.status, seed.stderr).toBe(0);
    // The harness's temp agents dir: both Python agents, the native host's and another app's.
    const agents = join(h.root, "LaunchAgents");
    mkdirSync(agents, { mode: 0o700 });
    const python = ["io.utopiasoft.cashu.worker", "io.github.synszakala.finanse.worker"];
    const kept = ["io.utopiasoft.cashu.host.plist", "com.example.synthetic.plist"];
    for (const name of [...python.map((label) => `${label}.plist`), ...kept])
      writeFileSync(join(agents, name), "<plist/>\n", { mode: 0o600 });

    const app = await h.launch({ E2E_RECOVERY_MIGRATE: "1" });
    const page = await recoveryWindow(app);
    await expect(page.getByTestId("recovery-code")).toHaveText("python_data_present");
    await page.getByRole("button", { name: "Zaimportuj moje dane" }).click();
    await expect(page.getByTestId("migration-recovery-phrase")).toBeVisible({ timeout: 90_000 });
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Kontynuuj import" }).click();
    await expect(page.getByText("Import zakończony.")).toBeVisible({ timeout: 90_000 });

    expect(readdirSync(agents).sort()).toEqual([...kept].sort());
    await expect(page.getByTestId("recovery-agents")).toHaveText(
      "Agenci w tle starej aplikacji (launchd): io.utopiasoft.cashu.worker: usunięty; io.github.synszakala.finanse.worker: usunięty.",
    );
    const launcher = join(h.dataDir, "bin", "cashu");
    const lines = [
      "claude mcp remove cashu-synthetic",
      `claude mcp add cashu-synthetic -- ${launcher} mcp --profile synthetic`,
    ];
    const mcp = page.getByTestId("recovery-mcp");
    await expect(mcp).toContainText("Podłącz ponownie agenta AI");
    await expect(mcp).toContainText(lines.join("\n"));
    await mcp.getByRole("button", { name: "Kopiuj" }).click();
    await expect(mcp.getByText("Skopiowano polecenia.")).toBeVisible();
    const copied = await app.evaluate(() => (globalThis as { __copied?: string[] }).__copied ?? []);
    expect(copied).toEqual([`${lines.join("\n")}\n`]);
    expect(readFileSync(join(h.root, "test-migrate-spawns"), "utf8")).toBe("migrate\n");
    expect(existsSync(join(h.dataDir, "migration.json"))).toBe(true);
  } finally {
    await h.cleanup();
  }
});
