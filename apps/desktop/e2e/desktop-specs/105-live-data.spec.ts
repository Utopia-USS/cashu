// S55l live data: with a screen open and no user action in the window, a write from each source
// reaches what the screen shows. The writers are the real processes: the agent's `cashu mcp` relay
// (stdio JSON-RPC), the `cashu` CLI, the host worker's forced run (`cashu worker run`) and a second
// UI client of the host (the shell is single-window by design, so the second window is the same
// `ui` session Electron main relays for its own window). Sync from a second device is proven at the
// host level (apps/host/src/liveSync.integration.test.ts): synthetic vaults have no sync engine.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomInt } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeValue, type StoreToClient } from "@cashu/host-protocol/store";
import { connectHost } from "@cashu/node-host";
import { demoExpectations, plus, rendered } from "../demo-expectations.ts";
import {
  currentVault,
  dashboardWindow,
  expect,
  launchDesktop,
  openProfileMenuItem,
  type Page,
  pickProfile,
  setPrivacy,
  stopHost,
  test,
  until,
} from "../electron-test.ts";
import { restoreNativeBaseline } from "../native-baseline.ts";

function paths() {
  const repo = process.env.E2E_REPO;
  const dataDir = process.env.E2E_NATIVE_DATA_DIR;
  if (!repo || !dataDir || !process.env.E2E_ROOT) throw new Error("isolated native demo absent");
  return { repo, dataDir, loader: join(repo, "tools/node-ts/resolveTs.ts") };
}

/** The synthetic demo host on the restored baseline; `env` adds a spec story (CASHU_E2E_*). */
async function serveDemo(env: Record<string, string> = {}): Promise<ChildProcess> {
  const { repo, dataDir, loader } = paths();
  await restoreNativeBaseline(dataDir);
  const host = spawn(
    process.execPath,
    ["--import", loader, join(repo, "apps/host/src/testing/seedOverviewDemo.ts"), "serve"],
    { env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "pipe"] },
  );
  let errors = "";
  host.stderr?.on("data", (chunk) => {
    errors += String(chunk);
  });
  const ready = join(dataDir, "overview-ready");
  await until(
    () =>
      (existsSync(ready) && readFileSync(ready, "utf8").trim() === String(host.pid)) ||
      host.exitCode !== null,
  );
  expect(host.exitCode, errors).toBeNull();
  return host;
}

async function stopDemo(host: ChildProcess): Promise<void> {
  await stopHost(paths().dataDir).catch(() => {});
  if (host.exitCode === null) {
    host.kill("SIGTERM");
    await until(() => host.exitCode !== null);
  }
}

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

/** A second UI client of the host (what a second window would be): store commands and live queries. */
async function uiClient() {
  const connection = await connectHost({ dataDir: paths().dataDir, role: "ui", build: "e2e105" });
  const replies = new Map<number, (message: StoreToClient) => void>();
  const subs = new Map<number, (message: StoreToClient) => void>();
  let closed = false;
  let announce: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    announce = resolve;
  });
  connection.onFrame((frame) => {
    if (frame.t !== "store") return;
    const message = frame.m as StoreToClient;
    if (message.t === "ready") {
      connection.send({ t: "store", m: { t: "uiPolicy", generation: 1, privacy: false } });
      announce();
    } else if (message.t === "result" || message.t === "failed")
      replies.get(message.rid)?.(message);
    else if (message.t === "value" || message.t === "error") subs.get(message.sid)?.(message);
  });
  connection.onClose(() => {
    closed = true;
    for (const settle of replies.values()) settle({ t: "failed" } as StoreToClient);
  });
  await ready;
  let next = 100;
  return {
    /** Runs one store command in `vault`; throws unless it completed. */
    run(vault: string, command: string, input: unknown): Promise<unknown> {
      const rid = ++next;
      return new Promise((resolve, reject) => {
        if (closed) return reject(new Error("second client connection closed"));
        replies.set(rid, (message) => {
          replies.delete(rid);
          if (message.t === "result" && message.outcome.kind === "completed")
            resolve(decodeValue(message.outcome.value));
          else reject(new Error(`second client ${command}: ${JSON.stringify(message)}`));
        });
        connection.send({
          t: "store",
          m: {
            t: "run",
            rid,
            generation: 1,
            key: runKey(),
            target: { kind: "vault", vault },
            command,
            input,
          } as never,
        });
      });
    },
    /** Subscribes to `query` in `vault`: every pushed value frame (an error frame fails the step). */
    subscribe(vault: string, query: string, args: unknown): { values: unknown[] } {
      const sid = ++next;
      const values: unknown[] = [];
      subs.set(sid, (message) => {
        if (message.t === "value") values.push(decodeValue(message.value));
        else values.push(new Error(`${query}: ${JSON.stringify(message)}`));
      });
      connection.send({
        t: "store",
        m: {
          t: "sub",
          sid,
          generation: 1,
          resume: false,
          target: { kind: "vault", vault },
          query,
          args,
        } as never,
      });
      return { values };
    },
    close: () => connection.close(),
  };
}

/** A second UI client of the host runs one store command in `vault`. */
async function secondClientRun(vault: string, command: string, input: unknown): Promise<unknown> {
  const client = await uiClient();
  try {
    return await client.run(vault, command, input);
  } finally {
    client.close();
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

/** Opens the investments alerts manager (Inwestycje -> Alerty -> + Nowy) for Demo Anna. */
async function openAlerts(page: Page) {
  await setPrivacy(page, false);
  await pickProfile(page, "Demo Anna");
  await page
    .getByRole("navigation", { name: "Moduły" })
    .getByRole("button", { name: "Inwestycje", exact: true })
    .click();
  const rail = page.getByTestId("native-portfolio");
  await expect(rail).toBeVisible();
  await rail
    .getByRole("region", { name: "Alerty" })
    .getByRole("button", { name: "+ Nowy", exact: true })
    .click();
  const alerts = page.getByTestId("native-signals-alerts");
  await expect(alerts).toBeVisible();
  return alerts;
}

test("agent writes reach the open alerts screen: one write, an unchanged re-run and a burst of 20", async () => {
  const host = await serveDemo();
  let app: Awaited<ReturnType<typeof launchDesktop>> | undefined;
  let mcp: Awaited<ReturnType<typeof mcpSession>> | undefined;
  let second: Awaited<ReturnType<typeof uiClient>> | undefined;
  try {
    app = await launchDesktop({ dataDir: paths().dataDir });
    const { page } = await dashboardWindow(app);
    const alerts = await openAlerts(page);
    const row = (title: string) => alerts.getByRole("row").filter({ hasText: title }).first();
    mcp = await mcpSession("demo-anna");

    // 1. One agent write appears without any action in the window.
    await expect(row("Synthetic A2 agent alert")).toHaveCount(0);
    await mcp.tool("add_alert", alert("Synthetic A2 agent alert"));
    await expect(row("Synthetic A2 agent alert")).toBeVisible();

    // 6. A write that re-runs the screen's queries without changing what it shows. The second UI
    // client re-saves the agent alert with its own title: the alerts table changes (updated_at), so
    // every query reading it re-runs. At the host: the signals screen query (its value carries
    // updated_at) pushes exactly one frame, which proves the re-run, while the instrument metadata
    // query (it reads the alerts table through the vault's instrument references, a set a title
    // cannot change) re-runs to an equal result and pushes nothing. In the window: the pushed signals
    // value renders the same, so the DOM does not change: no node added or removed, no text or
    // attribute ending a batch on another value. (React re-assigns an input's type and clears and
    // restores its name on every render; records that leave an attribute as it was before their
    // batch are counted, not changes.) The marker after
    // it renames the same alert, pushed on the same port after the re-save: once the new title shows,
    // the re-save's push was applied. Every MutationObserver record is classified on its own: only the
    // rename may change something.
    const vault = currentVault(page);
    const today = process.env.E2E_TODAY ?? new Date().toISOString().slice(0, 10);
    second = await uiClient();
    const signals = second.subscribe(vault, "investments.signals.screen", {
      now: new Date(`${today}T00:00:00`).toISOString(),
      today,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      lang: "pl",
      privacy: false,
    });
    const metadata = second.subscribe(vault, "investments.desktop.metadata", { lang: "pl" });
    await until(() => signals.values.length > 0 && metadata.values.length > 0);
    type AlertWire = { gid: string; title: string; updatedAt: string };
    const alertsIn = (value: unknown) => {
      if (value instanceof Error) throw value;
      return ((value as { alerts?: AlertWire[] }).alerts ?? []) as AlertWire[];
    };
    const agentAlert = alertsIn(signals.values[0]).find(
      (a) => a.title === "Synthetic A2 agent alert",
    );
    if (agentAlert === undefined) throw new Error("the agent alert is not in the signals query");
    await alerts.evaluate((root, marker) => {
      const probe = {
        stray: [] as string[],
        marker: 0,
        phase: "resave" as "resave" | "marker",
        resets: { resave: 0, marker: 0 },
      };
      const observer = new MutationObserver((records) => {
        // A node's attribute (or text) as it was before this batch: its first record's old value.
        const before = new Map<Node, Map<string | null, string | null>>();
        for (const record of records) {
          const own = before.get(record.target) ?? new Map<string | null, string | null>();
          if (!own.has(record.attributeName)) own.set(record.attributeName, record.oldValue);
          before.set(record.target, own);
        }
        for (const record of records) {
          const node =
            record.target instanceof Element ? record.target : record.target.parentElement;
          const added = [...record.addedNodes].map((n) => n.textContent ?? "").join("");
          const rename =
            (record.type === "characterData" &&
              (record.target.textContent ?? "").includes(marker)) ||
            (record.type === "childList" && added.includes(marker)) ||
            (record.type === "attributes" &&
              (node?.getAttribute(record.attributeName ?? "") ?? "").includes(marker));
          const was = before.get(record.target)?.get(record.attributeName);
          const same =
            (record.type === "attributes" &&
              was === (node?.getAttribute(record.attributeName ?? "") ?? null)) ||
            (record.type === "characterData" && was === record.target.textContent);
          if (rename) probe.marker += 1;
          else if (same) probe.resets[probe.phase] += 1;
          else {
            const where = `${node?.tagName.toLowerCase() ?? "?"}.${node?.getAttribute("class")?.split(" ")[0] ?? ""}`;
            const what =
              record.type === "attributes"
                ? `${record.attributeName}=${node?.getAttribute(record.attributeName ?? "")}`
                : (record.target.textContent ?? "").slice(0, 60);
            probe.stray.push(`${record.type} ${where} ${what}`);
          }
        }
      });
      observer.observe(root, {
        subtree: true,
        childList: true,
        characterData: true,
        characterDataOldValue: true,
        attributes: true,
        attributeOldValue: true,
      });
      (
        window as unknown as { liveProbe: { probe: typeof probe; observer: MutationObserver } }
      ).liveProbe = { probe, observer };
    }, "Synthetic A2 marker alert");
    await second.run(vault, "investments.signals.updateAlert", {
      alert: agentAlert.gid,
      changes: { title: "Synthetic A2 agent alert" },
    });
    await until(() => signals.values.length > 1);
    const resaved = alertsIn(signals.values[1]).find((a) => a.gid === agentAlert.gid);
    expect(resaved?.title).toBe("Synthetic A2 agent alert");
    expect(resaved?.updatedAt).not.toBe(agentAlert.updatedAt);
    // Both subscriptions re-ran in the same apply; give any late frame and the window's render time.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(signals.values, "signals frames after one re-save").toHaveLength(2);
    expect(metadata.values, "metadata frames after a re-run to an equal value").toHaveLength(1);
    await page.evaluate(() => {
      (window as unknown as { liveProbe: { probe: { phase: string } } }).liveProbe.probe.phase =
        "marker";
    });
    await second.run(vault, "investments.signals.updateAlert", {
      alert: agentAlert.gid,
      changes: { title: "Synthetic A2 marker alert" },
    });
    await expect(row("Synthetic A2 marker alert")).toBeVisible();
    const probe = await page.evaluate(() => {
      const live = (
        window as unknown as {
          liveProbe: {
            probe: { stray: string[]; marker: number; resets: Record<string, number> };
            observer: MutationObserver;
          };
        }
      ).liveProbe;
      live.observer.disconnect();
      return live.probe;
    });
    process.stdout.write(
      `live re-save: no-op attribute re-sets ${probe.resets.resave} (re-save), ${probe.resets.marker} (rename)\n`,
    );
    expect(probe.marker, "records of the rename").toBeGreaterThan(0);
    expect(probe.stray, "records not explained by the rename").toEqual([]);
    expect(metadata.values, "metadata frames after a rename").toHaveLength(1);
    second.close();
    second = undefined;

    // 7. A burst of 20 agent writes, sent at once: the screen only moves forward and ends on the
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
    second?.close();
    await mcp?.close().catch(() => {});
    await app?.close().catch(() => {});
    await stopDemo(host);
  }
});

test("a CLI command and a second UI client reach the open Overview", async () => {
  const host = await serveDemo();
  let app: Awaited<ReturnType<typeof launchDesktop>> | undefined;
  try {
    app = await launchDesktop({ dataDir: paths().dataDir });
    const { page } = await dashboardWindow(app);
    await setPrivacy(page, false);
    await pickProfile(page, "Demo Anna");
    const anna = currentVault(page);
    const expected = demoExpectations().anna;
    const worth = page.getByTestId("net-worth");
    await expect(worth).toHaveText(rendered(expected.net, expected.currency));

    // 2. The CLI books a cash expense of 7.
    const booked = cashu("--profile", "demo-anna", "cash-add", "7", "Synthetic A2 CLI", "dining");
    expect(booked.status, booked.stderr).toBe(0);
    await expect(worth).toHaveText(rendered(plus(expected.net, "-7"), expected.currency));

    // 4. Another UI client adds a property worth 3 (the Overview asset drawer's command).
    await secondClientRun(anna, "assets.createOverviewAsset", {
      name: "Synthetic A2 second window",
      type: "property",
      value: "3",
      currency: expected.currency,
      onDate: process.env.E2E_TODAY,
    });
    await expect(worth).toHaveText(rendered(plus(expected.net, "-4"), expected.currency));
  } finally {
    await app?.close().catch(() => {});
    await stopDemo(host);
  }
});

test("a daily worker run reaches the open Settings", async () => {
  const host = await serveDemo({ CASHU_E2E_WORKER: "1" });
  let app: Awaited<ReturnType<typeof launchDesktop>> | undefined;
  try {
    app = await launchDesktop({ dataDir: paths().dataDir });
    const { page } = await dashboardWindow(app);
    await setPrivacy(page, false);
    await pickProfile(page, "Demo Anna");
    await openProfileMenuItem(page, "Ustawienia");
    const worker = page.getByRole("region", { name: "Praca w tle", exact: true });
    await expect(worker).toContainText("Brak zapisanych przebiegów.");
    await expect(worker.getByRole("row").filter({ hasText: "Sprawdzenie reguł" })).toHaveCount(0);

    // 3. The worker's forced run (offline, no bank sync) records its jobs.
    const run = cashu("worker", "run", "--offline", "--no-budget");
    expect(run.status, run.stderr).toBe(0);
    await expect(
      worker.getByRole("row").filter({ hasText: "Sprawdzenie reguł" }).first(),
    ).toBeVisible();
    await expect(worker).not.toContainText("Brak zapisanych przebiegów.");
  } finally {
    await app?.close().catch(() => {});
    await stopDemo(host);
  }
});
