// Synthetic socket-level registration and Python/native validator differential acceptance.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { market } from "@cashu/domain/investments";
import { CEILING_KEY } from "@cashu/mcp";
import { connectHost } from "@cashu/node-host";
import { runCommand, setModules, setProfileSettings } from "@cashu/store";
import { afterEach, expect, it, vi } from "vitest";
import { startLocalHost } from "../host.js";
import { currentRuntime } from "../runtime.js";
import { cleanup, tempDir, testHostOptions } from "../testing/harness.js";
import { initializeMcp, isolatedMcpEnv, mcpClient } from "../testing/mcp.js";
import { HAS_PYTHON, python } from "../testing/python.js";
import * as pythonMcp from "./python.js";

type Json = Record<string, unknown>;
const FINANCIAL = [
  "spending_breakdown",
  "cashflow_summary",
  "recurring_payments",
  "uncategorized_merchants",
  "loans_summary",
];
const result = (reply: Json) => reply.result as Json;
const data = (reply: Json) => result(reply).structuredContent as Json;
const PYTHON_CLI = fileURLToPath(new URL("../../../../.venv/bin/cashu", import.meta.url));
afterEach(cleanup);
afterEach(() => vi.restoreAllMocks());

it.each([true, false])(
  "serves native-only financial reads with an accurate inventory (file authority: %s)",
  async (authority) => {
    const dataDir = tempDir();
    const cwd = tempDir();
    writeFileSync(join(cwd, "invalid.json"), "{");
    const h = await startLocalHost({
      ...testHostOptions(dataDir),
      launcher: false,
      python: null,
      runtime: { ...currentRuntime(), checkout: undefined },
      mcpPrices: new market.InMemoryPriceCache(),
      mcpFxNewest: () => null,
      ...(authority ? { mcpLegacyDataDir: join(tempDir(), "legacy") } : {}),
    });
    const vault = [...h.stores.vaults.values()][0];
    if (!vault) throw new Error("missing synthetic vault");
    await vault.queue.run(() =>
      runCommand(
        vault.store,
        vault.writer,
        setModules,
        { moduleIds: ["budget", "loans"] },
        vault.env,
      ),
    );
    const conn = await connectHost({ dataDir, role: "mcp", profile: "demo", build: "test" });
    const client = mcpClient(
      (line) => conn.send({ t: "mcp", line }),
      (cb) =>
        conn.onFrame((frame) => {
          if (frame.t === "mcp") cb(frame.line);
        }),
    );
    try {
      await conn.call("mcp.open", { cwd, env: {} });
      await initializeMcp(client);
      const listed = (result(await client.call("tools/list")).tools as Json[]).map(
        (tool) => tool.name,
      );
      expect(listed).toEqual(expect.arrayContaining(FINANCIAL));
      expect(listed).not.toContain("set_merchant_category");
      expect(listed.includes("validate_budget_import")).toBe(authority);
      for (const name of FINANCIAL)
        expect(result(await client.call("tools/call", { name })).isError).not.toBe(true);
      const overview = data(await client.call("tools/call", { name: "profile_overview" }));
      const inventory = [
        ...(overview.core_tools as string[]),
        ...(overview.modules as Json[]).flatMap((module) => module.tools as string[]),
      ];
      expect(new Set(inventory)).toEqual(new Set(listed));
      if (authority) {
        const checked = await client.call("tools/call", {
          name: "validate_budget_import",
          arguments: { path: "invalid.json" },
        });
        expect(result(checked).isError).not.toBe(true);
        expect(data(checked).ok).toBe(false);
      }
      expect(
        result(
          await client.call("tools/call", {
            name: "set_merchant_category",
            arguments: { merchant: "Synthetic", category: "dining" },
          }),
        ).isError,
      ).toBe(true);
    } finally {
      conn.close();
      await h.stop();
    }
  },
);

it.skipIf(!HAS_PYTHON)(
  "matches actual Python validator bytes while keeping mixed financial reads and writes coherent",
  async () => {
    const dataDir = tempDir();
    const cwd = tempDir();
    const env = isolatedMcpEnv(dataDir);
    expect(python("from cashu.core import paths\nprint(paths.data_dir())", env).trim()).toBe(
      dataDir,
    );
    python(
      [
        "from datetime import date",
        "from decimal import Decimal",
        "from cashu.core.db import init_db,get_session",
        "from cashu.core.profiles import create_profile",
        "from cashu.core.models import Account,Source",
        "from cashu.modules.budget.models import Transaction",
        "init_db()",
        "with get_session() as s:",
        " p=create_profile(s,name='Demo',slug='demo',modules_=['budget','loans'],mcp_privacy='amounts')",
        " a=Account(profile_id=p.id,bank='manual',name='Synthetic owner',type='checking',currency='PLN')",
        " s.add(a)",
        " s.flush()",
        " s.add(Transaction(account_id=a.id,booking_date=date(2026,11,1),amount=Decimal('-5'),source=Source.MANUAL,dedup_hash='synthetic-mcp-category',counterparty_name='Synthetic Private',counterparty_iban='PL99114000000000000000000002',category='other',category_source='default'))",
      ].join("\n"),
      env,
    );
    const childCalls: string[][] = [];
    const realStart = pythonMcp.startPythonMcp;
    vi.spyOn(pythonMcp, "startPythonMcp").mockImplementation((options) => {
      const child = realStart(options);
      const calls: string[] = [];
      childCalls.push(calls);
      return {
        ...child,
        send(line) {
          const msg = JSON.parse(line) as Json;
          if (msg.method === "tools/call") calls.push(String((msg.params as Json).name));
          child.send(line);
        },
      };
    });
    const h = await startLocalHost({
      ...testHostOptions(dataDir),
      launcher: false,
      python: { command: PYTHON_CLI, args: [] },
      runtime: { ...currentRuntime(), env },
    });
    const vault = [...h.stores.vaults.values()][0];
    if (!vault) throw new Error("missing synthetic vault");
    await vault.queue.run(() =>
      runCommand(
        vault.store,
        vault.writer,
        setModules,
        { moduleIds: ["budget", "loans"] },
        vault.env,
      ),
    );
    const conn = await connectHost({ dataDir, role: "mcp", profile: "demo", build: "test" });
    const native = mcpClient(
      (line) => conn.send({ t: "mcp", line }),
      (cb) =>
        conn.onFrame((frame) => {
          if (frame.t === "mcp") cb(frame.line);
        }),
    );
    const child = pythonMcp.startPythonMcp({
      program: { command: PYTHON_CLI, args: [] },
      dataDir,
      profile: "demo",
      open: { cwd, env: {} },
      env,
    });
    const direct = mcpClient(
      (line) => child.send(line),
      (cb) => child.onLine(cb),
    );
    const document = {
      format: "cashu-budget-import",
      format_version: 1,
      source: "synthetic",
      account: {
        institution: "xtb",
        iban: "PL99114000000000000000000001",
        name: "Synthetic account",
        currency: "PLN",
      },
      transactions: [
        {
          booking_date: "2026-10-04",
          amount: "-42.10",
          currency: "PLN",
          transaction_id: "synthetic-first",
        },
      ],
      balances: [{ date: "2026-10-05", amount: "100" }],
    };
    const fixtures = [
      ["valid.json", JSON.stringify(document)],
      [
        "valid.csv",
        "format_version,account_iban,account_currency,booking_date,amount,currency\n1,PL99114000000000000000000001,PLN,2026-10-04,-5.00,PLN\n",
      ],
      ["malformed.json", "{"],
      [
        "many.json",
        JSON.stringify({
          ...document,
          transactions: Array.from({ length: 55 }, () => ({
            booking_date: "invalid",
            amount: "bad",
            currency: "PLN",
          })),
        }),
      ],
    ] as const;
    for (const [name, text] of fixtures) writeFileSync(join(cwd, name), text);
    try {
      await conn.call("mcp.open", { cwd, env: {} });
      await initializeMcp(native);
      await initializeMcp(direct);
      expect(childCalls).toHaveLength(2);
      for (const privacy of ["strict", "amounts"] as const) {
        await vault.queue.run(() =>
          runCommand(
            vault.store,
            vault.writer,
            setProfileSettings,
            { mcpPrivacy: privacy },
            vault.env,
          ),
        );
        for (const [name] of fixtures) {
          const args = { name: "validate_budget_import", arguments: { path: name } };
          const actual = result(await native.call("tools/call", args));
          const oracle = result(
            await direct.call("tools/call", { ...args, _meta: { [CEILING_KEY]: privacy } }),
          );
          const { _meta, ...publicOracle } = oracle; // Only the private bridge acknowledgement differs.
          expect(actual, `${privacy}/${name}`).toEqual(publicOracle);
        }
      }
      expect(childCalls[1]).not.toContain("validate_budget_import");
      for (const name of FINANCIAL)
        expect(result(await native.call("tools/call", { name })).isError).not.toBe(true);
      expect(childCalls[1]).toEqual(FINANCIAL);
      const merchants = data(await native.call("tools/call", { name: "uncategorized_merchants" }))
        .merchants as Json[];
      expect(merchants).toHaveLength(1);
      expect(merchants[0]?.merchant).toMatch(/^payee:[a-p]{10}$/);
      const written = await native.call("tools/call", {
        name: "set_merchant_category",
        arguments: { merchant: merchants[0]?.merchant, category: "dining" },
      });
      expect(result(written).isError).not.toBe(true);
      expect(data(written).updated_transactions).toBe(1);
      expect(
        data(await native.call("tools/call", { name: "uncategorized_merchants" })).merchants,
      ).toEqual([]);
    } finally {
      conn.close();
      await child.close();
      await h.stop();
    }
  },
);
