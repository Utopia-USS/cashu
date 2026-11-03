/** Genuine native investment writes through the host socket, with per-call capability checks. */
import { parseDateTime, sha256Hex } from "@cashu/domain";
import { asProfileId, market } from "@cashu/domain/investments";
import {
  encodeEntityRef,
  investmentWriteServices,
  type NativeToolStore,
  type ToolContext,
} from "@cashu/mcp";
import { connectHost } from "@cashu/node-host";
import {
  investmentsCommands as C,
  type Command,
  runCommand,
  investmentsServices as S,
  setModules,
  setProfileSettings,
} from "@cashu/store";
import { afterEach, expect, it, vi } from "vitest";
import { startLocalHost } from "../host.js";
import { currentRuntime } from "../runtime.js";
import type { OpenVault } from "../stores.js";
import { cleanup, tempDir, testHostOptions } from "../testing/harness.js";
import { initializeMcp, mcpClient } from "../testing/mcp.js";
import * as pythonMcp from "./python.js";

const YAML = "version: 1\nbase_currency: PLN\ndata: {max_stale_weight: 1}\n";
const NAMES = [
  "set_recommendation",
  "set_recommendations",
  "record_decision",
  "upsert_thesis",
  "propose_strategy",
  "propose_custom_rule",
  "alerts",
  "add_alert",
  "mute_alert",
  "watchlist",
  "add_to_watchlist",
  "remove_from_watchlist",
];
afterEach(cleanup);
afterEach(() => vi.restoreAllMocks());
it.each([false, true])(
  "native socket investment writes preserve dependency partition, refs and lazy currentness: %s",
  async (available) => {
    const spy = vi.spyOn(pythonMcp, "startPythonMcp"),
      dataDir = tempDir(),
      prices = new market.InMemoryPriceCache();
    let now = Date.parse("2026-11-01T12:00:00Z"),
      vault: OpenVault | undefined,
      strategy: S.StrategyState | undefined,
      mismatch = false,
      throwing = false,
      foreignFiles = false,
      fileReads = 0;
    const contexts: string[] = [];
    const host = await startLocalHost({
      ...testHostOptions(dataDir),
      now: () => now,
      launcher: false,
      python: null,
      runtime: { ...currentRuntime(), checkout: undefined },
      ...(available
        ? {
            mcpInvestmentWrites: (ctx: ToolContext<NativeToolStore>) => {
              if (throwing) throw new Error("synthetic unavailable provider");
              if (!vault || !strategy) throw new Error("synthetic market inputs unavailable");
              contexts.push(ctx.today);
              const service = investmentWriteServices(ctx, {
                portfolio: {
                  vault: asProfileId(mismatch ? "22222222222222222222222222222222" : vault.id),
                  asOf: ctx.today,
                  clock: {
                    today: ctx.today,
                    now: parseDateTime(new Date(ctx.store.now()).toISOString()),
                    timeZone: "UTC",
                  },
                  strategy,
                  lang: "pl",
                  forOwner: false,
                  prices,
                },
                isHolder: () => false,
                strategyFiles: {
                  vault: asProfileId(mismatch ? "22222222222222222222222222222222" : vault.id),
                  isCurrent: () => true,
                  read: () => {
                    fileReads++;
                    return { yaml: YAML, md: null };
                  },
                },
              });
              return foreignFiles
                ? {
                    ...service,
                    strategyFiles: {
                      vault: "22222222222222222222222222222222",
                      isCurrent: () => true,
                      read: () => {
                        fileReads++;
                        return { yaml: YAML, md: null };
                      },
                    },
                  }
                : service;
            },
          }
        : {}),
    });
    let conn: Awaited<ReturnType<typeof connectHost>> | undefined;
    try {
      vault = [...host.stores.vaults.values()][0];
      if (!vault) throw new Error("synthetic vault missing");
      const bound = vault;
      const run = <I, V>(command: Command<I, V>, input: unknown): V => {
        const out = runCommand(bound.store, bound.writer, command, input, bound.env);
        if (!out.ok) throw new Error(out.reason);
        return out.value;
      };
      let instrument = "",
        signal = "";
      await bound.queue.run(() => {
        run(setModules, { moduleIds: ["investments"] });
        const account = run(C.addBrokerageAccount, {
          name: "Synthetic broker",
          broker: "dif",
        }).account;
        const content = new TextEncoder().encode(
          "format_version,record,date,time,type,external_ref,symbol,isin,name,exchange,quantity,price,currency,gross_amount,fee,tax,cash_amount,cash_currency,fx_rate,split_ratio,source\n1,txn,2026-01-01,,deposit,D,,,,,,,PLN,,,,1000,PLN,,,generic_csv\n1,txn,2026-01-01,,buy,B,ABC,PLABC0000016,Synthetic quoted holding,XWAR,10,100,PLN,1000,0,0,-1000,PLN,,,generic_csv\n",
        );
        run(C.commitImport, {
          account,
          file: { name: "history.csv", content },
          archive: { sha256: sha256Hex(content), ext: "csv" },
        });
        const rows = bound.store.read<{ gid: string }>(
          "SELECT gid FROM inv_instruments WHERE symbol = 'ABC'",
        );
        instrument = rows[0]?.gid ?? "";
        if (!instrument) throw new Error("imported synthetic instrument missing");
        signal =
          run(C.applySignalActions, {
            run: null,
            actions: [
              {
                type: "create",
                createdAt: new Date(now).toISOString(),
                candidate: {
                  ruleId: "synthetic_rule",
                  kind: "synthetic",
                  dedupKey: `synthetic_rule|i:${instrument}`,
                  severity: "info",
                  message: "Synthetic journal signal",
                  instrument,
                },
              },
            ],
          }).created[0] ?? "";
      });
      strategy = await S.loadStrategy(bound.store, {
        read: async (name) => (name === "strategy.yaml" ? YAML : null),
        write: async () => {},
        exists: async () => true,
      });
      conn = await connectHost({ dataDir, role: "mcp", profile: "demo", build: "test" });
      const connection = conn;
      const client = mcpClient(
        (line) => connection.send({ t: "mcp", line }),
        (callback) =>
          connection.onFrame((frame) => {
            if (frame.t === "mcp") callback(frame.line);
          }),
      );
      await conn.call("mcp.open", { cwd: tempDir(), env: {} });
      await initializeMcp(client);
      const listed = (await client.call("tools/list")).result as { tools: { name: string }[] };
      expect(
        listed.tools
          .map((t) => t.name)
          .filter((n) => NAMES.includes(n))
          .sort(),
      ).toEqual(NAMES.filter((n) => available || n !== "watchlist").sort());
      const request = async (name: string, args: Record<string, unknown> = {}) => {
        const result = (await client.call("tools/call", { name, arguments: args })).result as {
          isError?: boolean;
          structuredContent?: Record<string, unknown>;
        };
        return result;
      };
      const call = async (name: string, args: Record<string, unknown> = {}) => {
        const result = await request(name, args);
        expect(result.isError, name).not.toBe(true);
        if (!result.structuredContent) throw new Error("native response missing");
        return result.structuredContent;
      };
      if (available) {
        throwing = true;
        await call("setup_status", { module: "investments" });
        expect(contexts).toHaveLength(0);
        throwing = false;
      }
      const rec = await call("set_recommendation", {
        instrument: encodeEntityRef("instrument", instrument),
        recommendation: "buy",
        reason: "Current source facts",
      });
      expect(rec.instrument_id).toBe(encodeEntityRef("instrument", instrument));
      if (available) expect(contexts).toHaveLength(1);
      await call("set_recommendations", { scope: "all", recommendations: [] });
      const thesis = await call("upsert_thesis", {
        instrument: rec.instrument_id,
        entry_type: "trend",
        thesis: "Current synthetic proposition",
      });
      expect(typeof thesis.thesis_id).toBe("string");
      const added = await call("add_alert", {
        instrument: rec.instrument_id,
        kind: "price_below",
        params: { level: 90 },
        polarity: "negative",
        severity: "info",
        title: "Synthetic price condition",
      });
      const alert = added.alert as Record<string, unknown>;
      await call("alerts");
      await call("mute_alert", { id: alert.alert_id });
      await call("record_decision", {
        signal_id: encodeEntityRef("signal", signal),
        action: "held",
      });
      if (available) {
        const watched = await call("add_to_watchlist", {
          symbol_or_isin: rec.instrument_id,
          note: "Synthetic watch note",
        });
        const item = watched.item as Record<string, unknown>;
        const list = await call("watchlist");
        expect((list.items as unknown[]).length).toBe(1);
        await call("remove_from_watchlist", { id: item.item_id });
        await call("propose_strategy", { yaml: YAML, dry_run: true });
        await call("propose_strategy", { yaml: YAML });
        await call("propose_custom_rule", {
          kind_or_expression: "cash_level",
          params: { max_weight: 0.5 },
        });
        const before = bound.store.read<{ n: number }>("SELECT COUNT(*) AS n FROM inv_decisions")[0]
          ?.n;
        for (const bad of [
          encodeEntityRef("instrument", instrument),
          encodeEntityRef("signal", "01JF0000000000000000000000"),
          "signal:ubad",
        ])
          expect(
            (await request("record_decision", { signal_id: bad, action: "held" })).isError,
          ).toBe(true);
        expect(
          bound.store.read<{ n: number }>("SELECT COUNT(*) AS n FROM inv_decisions")[0]?.n,
        ).toBe(before);
        mismatch = true;
        expect(
          (
            await request("set_recommendation", {
              instrument: rec.instrument_id,
              recommendation: "hold",
              reason: "Changed facts",
            })
          ).isError,
        ).toBe(true);
        mismatch = false;
        foreignFiles = true;
        const reads = fileReads;
        for (const [name, args] of [
          ["propose_strategy", { yaml: YAML, dry_run: true }],
          [
            "propose_custom_rule",
            { kind_or_expression: "cash_level", params: { max_weight: 0.5 }, dry_run: true },
          ],
          [
            "add_alert",
            {
              kind: "weight_above",
              scope: "bucket",
              params: { threshold: 0.3, bucket: "current" },
              polarity: "neutral",
              severity: "info",
              title: "Synthetic bucket condition",
            },
          ],
        ] as const)
          expect((await request(name, args)).isError).toBe(true);
        expect(fileReads).toBe(reads);
        foreignFiles = false;
        now += 86400000;
        await bound.queue.run(() => run(setProfileSettings, { mcpPrivacy: "strict" }));
        await call("set_recommendation", {
          instrument: rec.instrument_id,
          recommendation: "hold",
          reason: "Day two facts",
        });
        expect(contexts.at(-1)).toBe("2026-11-02");
      } else {
        expect(
          (await request("add_to_watchlist", { symbol_or_isin: rec.instrument_id })).isError,
        ).toBe(true);
        expect((await request("propose_strategy", { yaml: YAML, dry_run: true })).isError).toBe(
          true,
        );
      }
      expect(
        bound.store
          .read<{ rule_id: string }>("SELECT rule_id FROM inv_signals")
          .some((r) => r.rule_id.startsWith("plan:")),
      ).toBe(false);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      conn?.close();
      await host.stop();
    }
  },
);
