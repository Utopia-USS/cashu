import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTranslator } from "@cashu/i18n";
import { expect, it, vi } from "vitest";
import { WorkerTickBusy } from "../worker/service.js";
import { createProductionWorkspaceProvider } from "../workspace/production.js";
import type { CommandIo } from "./tree.js";
import { workerWorkspaceCommands } from "./workerWorkspace.js";

function io() {
  const stdout = vi.fn();
  const stderr = vi.fn();
  const value: CommandIo = {
    cwd: realpathSync(tmpdir()),
    env: { CASHU_LANG: "en" },
    tty: { stdin: false, stdout: false, stderr: false },
    signal: new AbortController().signal,
    t: createTranslator("en"),
    stdout,
    stderr,
    prompt: async () => null,
    stdin: async function* () {},
  };
  return { value, stdout, stderr };
}

it("passes an invocation-only offline option and reports a busy worker", async () => {
  const tick = vi.fn(async () => {});
  const commands = workerWorkspaceCommands({
    stores: { vaults: new Map() },
    worker: () => ({ tick, status: () => ({ state: "idle" }) }) as never,
    service: () => null,
  });
  const output = io();
  expect(await commands[0]?.run(["run", "--offline"], output.value, {})).toBe(0);
  expect(tick).toHaveBeenCalledWith(true, { offline: true });
  tick.mockRejectedValueOnce(new WorkerTickBusy());
  expect(await commands[0]?.run(["run", "--offline"], output.value, {})).toBe(1);
  expect(output.stderr).toHaveBeenCalledWith(expect.stringContaining("busy"));
});

it("applies budget and notifier overrides only to this run", async () => {
  const tick = vi.fn(async () => {});
  const commands = workerWorkspaceCommands({
    stores: { vaults: new Map() },
    worker: () => ({ tick, status: () => ({ state: "idle" }), hasAppNotifier: true }) as never,
  });
  const output = io();
  expect(
    await commands[0]?.run(["run", "--no-budget", "--notifier", "none"], output.value, {}),
  ).toBe(0);
  expect(tick).toHaveBeenLastCalledWith(true, { budget: false, notifier: "none" });
  expect(await commands[0]?.run(["run", "--notifier=app"], output.value, {})).toBe(0);
  expect(tick).toHaveBeenLastCalledWith(true, { notifier: "app" });
  expect(await commands[0]?.run(["run"], output.value, {})).toBe(0);
  expect(tick).toHaveBeenLastCalledWith(true, undefined);
});

it("refuses unavailable named transports before starting work", async () => {
  const tick = vi.fn(async () => {});
  const commands = workerWorkspaceCommands({
    stores: { vaults: new Map() },
    worker: () => ({ tick, hasAppNotifier: false }) as never,
  });
  const output = io();
  expect(await commands[0]?.run(["run", "--notifier", "app"], output.value, {})).toBe(69);
  expect(await commands[0]?.run(["run", "--notifier", "log"], output.value, {})).toBe(69);
  expect(tick).not.toHaveBeenCalled();
});

it("does not claim workspace completion when its checked provider is absent", async () => {
  const commands = workerWorkspaceCommands({
    stores: {
      vaults: new Map([
        [
          "v",
          {
            native: { isCurrent: () => true },
            store: {
              read: (sql: string) =>
                sql.includes("FROM profiles")
                  ? [
                      {
                        slug: "synthetic",
                        name: "Synthetic",
                        baseCurrency: "PLN",
                        mcpPrivacy: "strict",
                      },
                    ]
                  : [],
            },
          } as never,
        ],
      ]),
    },
    worker: () => null,
    service: () => null,
  });
  const output = io();
  expect(await commands[1]?.run(["init"], output.value, { profile: "synthetic" })).toBe(69);
  expect(output.stderr).toHaveBeenCalledWith(expect.stringContaining("unavailable"));
});

it("runs workspace init and path through the production provider for the exact vault", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "cashu-cli-workspace-")));
  try {
    const vaultId = "a".repeat(32);
    const home = join(root, "home");
    const dataRoot = join(root, "data");
    const skillSource = join(root, "assets", "skills");
    mkdirSync(join(skillSource, "workspace-setup"), { recursive: true });
    writeFileSync(
      join(skillSource, "workspace-setup", "SKILL.md"),
      "---\nname: workspace-setup\ndescription: |\n  Applicability - POSITIVE: synthetic.\n  Applicability - NEGATIVE: NOT other.\n---\n\nSynthetic skill.\n",
    );
    const profile = {
      slug: "synthetic",
      name: "Synthetic",
      baseCurrency: "PLN",
      mcpPrivacy: "strict",
      privacy: "strict",
      modules: [],
    };
    const store = {
      read: (sql: string) =>
        sql.includes("AS privacy")
          ? [{ slug: profile.slug, baseCurrency: profile.baseCurrency, privacy: profile.privacy }]
          : sql.includes("FROM profiles")
            ? [profile]
            : [],
    };
    const native = {
      id: vaultId,
      isCurrent: () => true,
      workspaceAuthority: () => ({
        vault: vaultId,
        generation: "synthetic",
        isCurrent: () => true,
      }),
      store,
    };
    const vault = { id: vaultId, native, store } as never;
    const inventory = [
      {
        vaultId,
        deviceId: "b".repeat(32),
        vaultRoot: join(dataRoot, "native", vaultId),
        state: "ready",
        enrollment: "creator",
      },
    ] as const;
    const provider = createProductionWorkspaceProvider({
      dataRoot,
      home,
      workspacesRoot: join(home, "Documents", "cashU"),
      skillSource,
      version: "synthetic",
      program: { command: "/synthetic/cashu", args: [] },
      sessions: (id) => (id === vaultId ? (native as never) : null),
      inventory: () => inventory,
    });
    const commands = workerWorkspaceCommands({
      stores: { vaults: new Map([[vaultId, vault]]) },
      workspace: provider,
      worker: () => null,
    });
    const output = io();
    expect(await commands[1]?.run(["init", "--profile", "synthetic"], output.value, {})).toBe(0);
    const path = join(home, "Documents", "cashU", "synthetic");
    expect(readFileSync(join(path, "CLAUDE.md"), "utf8")).toContain("cashU agent workspace");
    expect(await commands[1]?.run(["path", "--profile", "synthetic"], output.value, {})).toBe(0);
    expect(output.stdout).toHaveBeenLastCalledWith(`${path}\n`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("does not enable a service for an unknown worker action", async () => {
  const enable = vi.fn();
  const commands = workerWorkspaceCommands({
    stores: { vaults: new Map() },
    worker: () => null,
    service: () => ({ enable }) as never,
  });
  const output = io();
  expect(await commands[0]?.run(["approve"], output.value, {})).toBe(2);
  expect(enable).not.toHaveBeenCalled();
});
