// Real host socket plus isolated Python oracle. Both stores contain the same synthetic profile;
// the cache is explicitly supplied so every core handler runs natively, not via S22c fallback.

import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { market } from "@cashu/domain/investments";
import { mcpToolMetadata, toolDescriptor } from "@cashu/mcp";
import { connectHost } from "@cashu/node-host";
import { openAccount, runCommand, setModules, setProfileSettings } from "@cashu/store";
import { finishMcpCall, startMcpCall } from "@cashu/store/device";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startLocalHost } from "../host.js";
import { currentRuntime } from "../runtime.js";
import { cleanup, tempDir, testHostOptions } from "../testing/harness.js";
import {
  mcpClient as client,
  initializeMcp as initialize,
  isolatedMcpEnv as isolated,
} from "../testing/mcp.js";
import { HAS_PYTHON, python } from "../testing/python.js";
import * as pythonMcp from "./python.js";
import { startPythonMcp } from "./python.js";

type Json = Record<string, unknown>;
const PYTHON_CLI = fileURLToPath(new URL("../../../../.venv/bin/cashu", import.meta.url));
afterEach(cleanup);
afterEach(() => vi.restoreAllMocks());
const result = (response: Json) => response.result as Json;
const data = (response: Json) => result(response).structuredContent as Json;

describe.skipIf(!HAS_PYTHON)("native core over the real MCP host", () => {
  it("keeps all Python schemas while invoking all four native handlers and auditing on device", async () => {
    const forwardedCore: string[] = [];
    const realStart = pythonMcp.startPythonMcp;
    const startSpy = vi.spyOn(pythonMcp, "startPythonMcp").mockImplementation((options) => {
      const backend = realStart(options);
      return {
        ...backend,
        send(line) {
          const message = JSON.parse(line) as Json;
          const name = (message.params as Json | undefined)?.name;
          if (
            message.method === "tools/call" &&
            typeof name === "string" &&
            ["profile_overview", "setup_status", "networth_breakdown", "mark_review_done"].includes(
              name,
            )
          )
            forwardedCore.push(name);
          backend.send(line);
        },
      };
    });
    const dataDir = tempDir();
    const env = isolated(dataDir);
    expect(python("from cashu.core import paths\nprint(paths.data_dir())", env).trim()).toBe(
      dataDir,
    );
    python(
      [
        "from datetime import date",
        "from decimal import Decimal",
        "from cashu.core.db import init_db, get_session",
        "from cashu.core.profiles import create_profile",
        "from cashu.core.models import Account, Source",
        "from cashu.modules.budget.models import Transaction",
        "init_db()",
        "with get_session() as s:",
        " p = create_profile(s, name='Demo', slug='demo', modules_=['budget','assets','loans','investments'], mcp_privacy='amounts')",
        " a = Account(profile_id=p.id, bank='manual', name='Synthetic spending', type='checking', currency='PLN')",
        " s.add(a)",
        " s.flush()",
        " s.add(Transaction(account_id=a.id, booking_date=date(2026,11,1), amount=Decimal('-5'), source=Source.MANUAL, dedup_hash='synthetic-guard-test', counterparty_name='Native Boundary', category='other'))",
      ].join("\n"),
      env,
    );
    const h = await startLocalHost({
      ...testHostOptions(dataDir),
      launcher: false,
      python: { command: PYTHON_CLI, args: [] },
      runtime: { ...currentRuntime(), env },
      mcpPrices: new market.InMemoryPriceCache(),
      mcpFxNewest: () => null,
    });
    const vault = [...h.stores.vaults.values()][0];
    if (!vault) throw new Error("missing native fixture");
    await vault.queue.run(() =>
      runCommand(
        vault.store,
        vault.writer,
        setModules,
        { moduleIds: ["budget", "assets", "loans", "investments"] },
        vault.env,
      ),
    );
    const conn = await connectHost({ dataDir, role: "mcp", profile: "demo", build: "test" });
    const native = client(
      (line) => conn.send({ t: "mcp", line }),
      (cb) =>
        conn.onFrame((frame) => {
          if (frame.t === "mcp") cb(frame.line);
        }),
    );
    const child = startPythonMcp({
      program: { command: PYTHON_CLI, args: [] },
      dataDir,
      profile: "demo",
      open: { cwd: dataDir, env: {} },
      env,
    });
    const direct = client(
      (line) => child.send(line),
      (cb) => child.onLine(cb),
    );
    try {
      await conn.call("mcp.open", { cwd: dataDir, env: {} });
      expect(startSpy).toHaveBeenCalledTimes(2);
      await initialize(native);
      await initialize(direct);
      const nativeList = result(await native.call("tools/list"));
      expect(nativeList).toEqual(result(await direct.call("tools/list")));
      expect(nativeList.tools).toEqual(mcpToolMetadata().map(toolDescriptor));
      const overview = await native.call("tools/call", { name: "profile_overview" });
      expect(result(overview).isError).not.toBe(true);
      expect(data(overview).privacy).toBe("strict"); // Python fixture says amounts.
      expect(
        result(
          await native.call("tools/call", {
            name: "setup_status",
            arguments: { module: "assets" },
          }),
        ).isError,
      ).not.toBe(true);
      expect(
        data(await native.call("tools/call", { name: "networth_breakdown" })).currencies,
      ).toEqual([]);
      const review = await native.call("tools/call", {
        name: "mark_review_done",
        arguments: { module: "budget", notes: "Synthetic review" },
      });
      expect(result(review).isError).not.toBe(true);
      expect(data(review).review_id).toMatch(/^review:u[a-p]{52}$/);
      for (const malformed of [[], "invalid", 3]) {
        expect(
          result(
            await native.call("tools/call", { name: "mark_review_done", arguments: malformed }),
          ).isError,
        ).toBe(true);
      }
      expect(vault.store.read("SELECT COUNT(*) AS n FROM reviews")).toEqual([{ n: 1 }]);
      // Inspect only this fresh synthetic fixture. A second Python interpreter would merely
      // execute the same count query; keeping it here avoids importing the whole app again.
      const oracleDb = new DatabaseSync(join(dataDir, "cashu.db"), { readOnly: true });
      try {
        expect(
          oracleDb
            .prepare(
              "SELECT COUNT(*) AS n FROM reviews WHERE profile_id = (SELECT id FROM profiles WHERE slug = ?)",
            )
            .get("demo"),
        ).toEqual({ n: 0 });
      } finally {
        oracleDb.close();
      }
      expect(
        h.stores.device.store.read(
          "SELECT tool, outcome, privacy FROM mcp_calls WHERE outcome = 'ok' ORDER BY id",
        ),
      ).toEqual(
        ["profile_overview", "setup_status", "networth_breakdown", "mark_review_done"].map(
          (tool) => ({ tool, outcome: "ok", privacy: "strict" }),
        ),
      );
      await vault.queue.run(() =>
        runCommand(
          vault.store,
          vault.writer,
          setProfileSettings,
          { mcpPrivacy: "amounts" },
          vault.env,
        ),
      );
      expect(data(await native.call("tools/call", { name: "profile_overview" })).privacy).toBe(
        "amounts",
      );
      // A private name exists only in the native vault. Python's ordinary merchant guard does not
      // know it, so the hybrid bridge must add it before the delegated handler is redacted.
      await vault.queue.run(() =>
        runCommand(
          vault.store,
          vault.writer,
          openAccount,
          { bank: "manual", name: "Native Boundary", type: "checking", currency: "PLN" },
          vault.env,
        ),
      );
      const spending = { name: "spending_breakdown", arguments: { period: "2026-11" } };
      expect(JSON.stringify(data(await direct.call("tools/call", spending)))).toContain(
        "NATIVE BOUNDARY",
      );
      const guarded = await native.call("tools/call", spending);
      expect(result(guarded).isError).not.toBe(true);
      expect(JSON.stringify(data(guarded))).not.toContain("NATIVE BOUNDARY");
      expect(JSON.stringify(data(guarded))).toContain("payee:");
      await vault.queue.run(() =>
        runCommand(
          vault.store,
          vault.writer,
          setProfileSettings,
          { mcpPrivacy: "strict" },
          vault.env,
        ),
      );
      const strictDelegated = await native.call("tools/call", spending);
      expect(result(strictDelegated).isError).not.toBe(true);
      expect(data(strictDelegated).total).toBeUndefined();
      expect(forwardedCore).toEqual([]);
    } finally {
      conn.close();
      await child.close();
      await h.stop();
      startSpy.mockRestore();
    }
  });
});

it("flushes a queued call's refusal before graceful handover closes its session", async () => {
  const dataDir = tempDir();
  const h = await startLocalHost({
    ...testHostOptions(dataDir),
    launcher: false,
    python: null,
    mcpPrices: new market.InMemoryPriceCache(),
  });
  const conn = await connectHost({ dataDir, role: "mcp", profile: "demo", build: "test" });
  const c = client(
    (line) => conn.send({ t: "mcp", line }),
    (cb) =>
      conn.onFrame((frame) => {
        if (frame.t === "mcp") cb(frame.line);
      }),
  );
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = h.stores.device.queue.run.bind(h.stores.device.queue);
  const run = vi.spyOn(h.stores.device.store, "run");
  vi.spyOn(h.stores.device.queue, "run").mockImplementation(
    <T>(task: () => T): Promise<T> =>
      original(task).then(async (value) => {
        await held;
        return value;
      }),
  );
  try {
    await conn.call("mcp.open", { cwd: dataDir, env: {} });
    await initialize(c);
    const answer = c.call("tools/call", { name: "setup_status", arguments: { module: "budget" } });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    void h.stop("handover");
    await vi.waitFor(() => expect(h.status().stopping).toBe(true));
    release();
    const reply = result(await answer);
    expect(reply.isError).toBe(true);
    expect((reply.content as { text: string }[])[0]?.text).toContain("no longer active");
    expect(await h.exit).toBe(75);
    expect(run.mock.calls.map(([command]) => command.id)).toEqual([
      startMcpCall.id,
      finishMcpCall.id,
    ]);
  } finally {
    release();
    conn.close();
    await h.stop();
    vi.restoreAllMocks();
  }
});
