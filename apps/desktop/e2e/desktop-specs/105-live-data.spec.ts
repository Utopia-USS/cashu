// Live data: with a screen open and no user action in the window, a write from each source reaches
// what the screen shows. The writers are the real processes: the agent's `cashu mcp` relay (stdio
// JSON-RPC), the `cashu` CLI, the host worker's forced run (`cashu worker run`) and a second UI
// client of the host. Sync from a second device is proven at the host level
// (apps/host/src/liveSync.integration.test.ts): synthetic vaults have no sync engine.
import { spawn, spawnSync } from "node:child_process";
import { randomInt } from "node:crypto";
import { join } from "node:path";
import { decodeValue, type StoreToClient } from "@cashu/host-protocol/store";
import { connectHost } from "@cashu/node-host";
import { demoExpectations, plus, rendered } from "../demo-expectations.ts";
import { currentVault, expect, openProfileMenuItem, type Page, test } from "../electron-test.ts";
import { openNativeDemo, nativeDemoPaths as paths } from "../native-baseline.ts";

/** One `cashu` CLI command against the demo data dir (a thin client of the running host). */
function cashu(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const { repo, dataDir, loader } = paths();
  return spawnSync(
    process.execPath,
    ["--import", loader, join(repo, "apps/cli/src/index.ts"), ...args],
    {
      env: { ...process.env, CASHU_DATA_DIR: dataDir },
      encoding: "utf8",
      timeout: 20_000,
    },
  );
}

type ToolResult = {
  isError?: boolean;
  content?: { text?: string }[];
  structuredContent?: unknown;
};

/** The agent's MCP server: `cashu mcp --profile <slug>` speaking line-delimited JSON-RPC on stdio. */
async function mcpSession(profile: string) {
  const { repo, dataDir, loader } = paths();
  const child = spawn(
    process.execPath,
    ["--import", loader, join(repo, "apps/cli/src/index.ts"), "mcp", "--profile", profile],
    { env: { ...process.env, CASHU_DATA_DIR: dataDir }, stdio: ["pipe", "pipe", "pipe"] },
  );
  const pending = new Map<number, (message: Record<string, unknown> | Error) => void>();
  child.once("exit", (code) => {
    for (const settle of pending.values()) settle(new Error(`mcp relay exited (${code})`));
    pending.clear();
  });
  let rest = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    const lines = (rest + chunk).split("\n");
    rest = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim() === "") continue;
      const message = JSON.parse(line) as Record<string, unknown>;
      if (typeof message.id === "number") {
        pending.get(message.id)?.(message);
        pending.delete(message.id);
      }
    }
  });
  let next = 0;
  const request = (method: string, params: Record<string, unknown>) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = ++next;
      pending.set(id, (message) => (message instanceof Error ? reject(message) : resolve(message)));
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "e2e-105", version: "1" },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  return {
    /** Calls a tool; throws on a tool error so a refused write never passes silently. */
    async tool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
      const reply = await request("tools/call", { name, arguments: args });
      const result = reply.result as ToolResult | undefined;
      if (result === undefined || result.isError)
        throw new Error(`${name} failed: ${JSON.stringify(reply.error ?? result?.content)}`);
      return result;
    },
    async close() {
      child.stdin.end();
      if (child.exitCode === null) await new Promise((resolve) => child.once("exit", resolve));
    },
  };
}

/** A ULID-shaped idempotency key (the store channel's `run` key). */
function runKey(): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  return `0${Array.from({ length: 25 }, () => alphabet[randomInt(32)]).join("")}`;
}

/** A second UI client of the host (what a second window would be) runs one store command. */
async function secondClientRun(vault: string, command: string, input: unknown): Promise<unknown> {
  const connection = await connectHost({ dataDir: paths().dataDir, role: "ui", build: "e2e105" });
  try {
    return await new Promise((resolve, reject) => {
      connection.onFrame((frame) => {
        if (frame.t !== "store") return;
        const message = frame.m as StoreToClient;
        if (message.t === "ready") {
          connection.send({ t: "store", m: { t: "uiPolicy", generation: 1, privacy: false } });
          connection.send({
            t: "store",
            m: {
              t: "run",
              rid: 1,
              generation: 1,
              key: runKey(),
              target: { kind: "vault", vault },
              command,
              input,
            } as never,
          });
        } else if (message.t === "result" && message.outcome.kind === "completed")
          resolve(decodeValue(message.outcome.value));
        else if (message.t === "result" || message.t === "failed")
          reject(new Error(`second client ${command}: ${JSON.stringify(message)}`));
      });
      connection.onClose(() => reject(new Error("second client connection closed")));
    });
  } finally {
    connection.close();
  }
}

const alert = (title: string) => ({
  kind: "price_above",
  instrument: "DPOL",
  params: { level: 100000 },
  polarity: "neutral",
  severity: "info",
  title,
});

/** Opens the investments alerts manager (Inwestycje -> Alerty -> Wszystkie). */
async function openAlerts(page: Page) {
  await page
    .getByRole("navigation", { name: "Moduły" })
    .getByRole("button", { name: "Inwestycje", exact: true })
    .click();
  const rail = page.getByTestId("native-portfolio");
  await expect(rail).toBeVisible();
  await rail
    .getByRole("region", { name: "Alerty" })
    .getByRole("button", { name: /Wszystkie/u })
    .click();
  const alerts = page.getByTestId("native-signals-alerts");
  await expect(alerts).toBeVisible();
  return alerts;
}

test("agent writes reach the open alerts screen: one write, then a burst of 20 in order", async () => {
  const demo = await openNativeDemo();
  let mcp: Awaited<ReturnType<typeof mcpSession>> | undefined;
  try {
    const { page } = demo;
    const alerts = await openAlerts(page);
    const row = (title: string) => alerts.getByRole("row").filter({ hasText: title }).first();
    mcp = await mcpSession("demo-anna");

    // One agent write appears without any action in the window.
    await expect(row("Synthetic A2 agent alert")).toHaveCount(0);
    await mcp.tool("add_alert", alert("Synthetic A2 agent alert"));
    await expect(row("Synthetic A2 agent alert")).toBeVisible();

    // A burst of 20 agent writes, sent at once: the screen only moves forward and ends on the
    // last state (the observed value is the number of burst rows; -1 = the table is gone).
    await alerts.evaluate((root) => {
      const seen: number[] = [];
      (window as unknown as { liveBurst: number[] }).liveBurst = seen;
      const count = () => {
        const table = root.querySelector("table");
        if (table === null) return -1;
        return [...table.querySelectorAll("tr")].filter((tr) =>
          tr.textContent?.includes("Synthetic A2 burst "),
        ).length;
      };
      new MutationObserver(() => {
        const value = count();
        if (seen.at(-1) !== value) seen.push(value);
      }).observe(root, { subtree: true, childList: true, characterData: true });
    });
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        mcp?.tool("add_alert", alert(`Synthetic A2 burst ${String(i + 1).padStart(2, "0")}`)),
      ),
    );
    await expect(row("Synthetic A2 burst 20")).toBeVisible();
    await expect(alerts.getByRole("row").filter({ hasText: "Synthetic A2 burst " })).toHaveCount(
      20,
    );
    const sequence = await page.evaluate(
      () => (window as unknown as { liveBurst: number[] }).liveBurst,
    );
    process.stdout.write(`live burst sequence: ${sequence.join(",")}\n`);
    expect(sequence.length).toBeGreaterThan(0);
    expect(sequence.at(-1)).toBe(20);
    for (const [i, value] of sequence.entries()) {
      expect(value, `burst sequence ${sequence.join(",")}`).toBeGreaterThanOrEqual(0);
      if (i > 0)
        expect(value, `burst sequence ${sequence.join(",")}`).toBeGreaterThan(sequence[i - 1] ?? 0);
    }
  } finally {
    await mcp?.close().catch(() => {});
    await demo.close();
  }
});

test("a CLI command and a second UI client reach the open Overview", async () => {
  const demo = await openNativeDemo();
  try {
    const { page } = demo;
    const anna = currentVault(page);
    const expected = demoExpectations().anna;
    const worth = page.getByTestId("net-worth");
    await expect(worth).toHaveText(rendered(expected.net, expected.currency));

    // The CLI books a cash expense of 7.
    const booked = cashu("--profile", "demo-anna", "cash-add", "7", "Synthetic A2 CLI", "dining");
    expect(booked.status, booked.stderr).toBe(0);
    await expect(worth).toHaveText(rendered(plus(expected.net, "-7"), expected.currency));

    // Another UI client adds a property worth 3 (the Overview asset drawer's command).
    await secondClientRun(anna, "assets.createOverviewAsset", {
      name: "Synthetic A2 second window",
      type: "property",
      value: "3",
      currency: expected.currency,
      onDate: process.env.E2E_TODAY,
    });
    await expect(worth).toHaveText(rendered(plus(expected.net, "-4"), expected.currency));
  } finally {
    await demo.close();
  }
});

test("a daily worker run reaches the open Settings", async () => {
  const demo = await openNativeDemo({ env: { CASHU_E2E_WORKER: "1" } });
  try {
    const { page } = demo;
    await openProfileMenuItem(page, "Ustawienia");
    const worker = page.getByRole("region", { name: "Praca w tle", exact: true });
    await expect(worker).toContainText("Brak zapisanych przebiegów.");
    await expect(worker.getByRole("row").filter({ hasText: "Sprawdzenie reguł" })).toHaveCount(0);

    // The worker's forced run (offline, no bank sync) records its jobs.
    const run = cashu("worker", "run", "--offline", "--no-budget");
    expect(run.status, run.stderr).toBe(0);
    await expect(
      worker.getByRole("row").filter({ hasText: "Sprawdzenie reguł" }).first(),
    ).toBeVisible();
    await expect(worker).not.toContainText("Brak zapisanych przebiegów.");
  } finally {
    await demo.close();
  }
});
