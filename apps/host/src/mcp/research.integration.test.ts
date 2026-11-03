/** Real socket registration and actual native writes; no Python process or replayed result. */
import { parseDateTime } from "@cashu/domain";
import { asProfileId, market } from "@cashu/domain/investments";
import {
  encodeEntityRef,
  type NativeToolStore,
  researchServices,
  type ToolContext,
} from "@cashu/mcp";
import { connectHost } from "@cashu/node-host";
import {
  investmentsCommands as C,
  type Command,
  investmentsResearch as R,
  runCommand,
  investmentsServices as S,
  setModules,
} from "@cashu/store";
import { afterEach, expect, it, vi } from "vitest";
import { startLocalHost } from "../host.js";
import { currentRuntime } from "../runtime.js";
import type { OpenVault } from "../stores.js";
import { cleanup, tempDir, testHostOptions } from "../testing/harness.js";
import { initializeMcp, mcpClient } from "../testing/mcp.js";
import * as pythonMcp from "./python.js";

type Json = Record<string, unknown>;
const NAMES = [
  "research_context",
  "research_notes",
  "start_research_run",
  "add_research_note",
  "set_topic_market_view",
  "upsert_topic_thesis",
  "finish_research_run",
  "set_instrument_segment",
];
afterEach(cleanup);
afterEach(() => vi.restoreAllMocks());
it.each([false, true])(
  "actual socket keeps research dependency partition and opaque run roundtrip: %s",
  async (available) => {
    const spy = vi.spyOn(pythonMcp, "startPythonMcp"),
      dataDir = tempDir(),
      prices = new market.InMemoryPriceCache();
    let now = Date.parse("2026-11-01T12:00:00Z"),
      vault: OpenVault | undefined,
      strategy: S.StrategyState | undefined,
      mismatched = false,
      throwing = false;
    const contexts: string[] = [];
    const researchOptions = available
      ? {
          mcpResearch: (ctx: ToolContext<NativeToolStore>) => {
            if (throwing) throw new Error("synthetic unavailable research binding");
            if (!vault || !strategy) throw new Error("synthetic research inputs unavailable");
            contexts.push(ctx.today);
            return researchServices(ctx, {
              portfolio: {
                vault: asProfileId(mismatched ? "22222222222222222222222222222222" : vault.id),
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
              macroCloses: {},
              isHolder: (id) => id === vault?.id,
            });
          },
        }
      : {};
    const host = await startLocalHost({
      ...testHostOptions(dataDir),
      now: () => now,
      launcher: false,
      python: null,
      runtime: { ...currentRuntime(), checkout: undefined },
      ...researchOptions,
    });
    let conn: Awaited<ReturnType<typeof connectHost>> | undefined,
      foreign: Awaited<ReturnType<typeof startLocalHost>> | undefined;
    try {
      vault = [...host.stores.vaults.values()][0];
      if (!vault) throw new Error("missing synthetic vault");
      const bound = vault;
      const run = <I, V>(command: Command<I, V>, input: unknown): V => {
        const out = runCommand(bound.store, bound.writer, command, input, bound.env);
        if (!out.ok) throw new Error(out.reason);
        return out.value;
      };
      let instrument = "";
      await bound.queue.run(() => {
        run(setModules, { moduleIds: ["investments"] });
        const account = run(C.addBrokerageAccount, {
          name: "Synthetic research account",
          broker: "dif",
        }).account;
        instrument = run(C.addToWatchlist, {
          target: {
            planned: {
              symbol: "ABC",
              isin: "PLABC0000016",
              name: "Synthetic quoted holding",
              currency: "PLN",
              assetClass: "equity",
              mic: "XWAR",
              aliases: [{ namespace: "yahoo", value: "ABC.WA" }],
            },
          },
        }).instrument;
        run(C.addManualTransaction, {
          account,
          type: "deposit",
          tradeDate: "2026-01-01",
          cashAmount: "1000",
          currency: "PLN",
        });
        run(C.addManualTransaction, {
          account,
          instrument,
          type: "buy",
          tradeDate: "2026-01-01",
          quantity: "10",
          price: "100",
          cashAmount: "-1000",
          currency: "PLN",
        });
        run(C.createThesis, {
          instrument,
          entryType: "trend",
          thesis: "Popyt utrzymuje się przez cykl.",
        });
        run(C.setInstrumentPlan, { instrument, plan: "buy", reason: null, held: true });
      });
      strategy = await S.loadStrategy(bound.store, {
        read: async (name) =>
          name === "strategy.yaml"
            ? "version: 1\nbase_currency: PLN\ndata: {max_stale_weight: 1}\n"
            : null,
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
      const listed = (await client.call("tools/list")).result as {
        tools: { name: string; inputSchema: { properties: Record<string, { type: string }> } }[];
      };
      expect(
        listed.tools
          .map((row) => row.name)
          .filter((name) => NAMES.includes(name))
          .sort(),
      ).toEqual(NAMES.filter((name) => available || name !== "research_context").sort());
      const call = async (name: string, args: Json = {}) => {
        const response = await client.call("tools/call", { name, arguments: args });
        const result = response.result as { isError?: boolean; structuredContent?: Json };
        expect(result.isError, name).not.toBe(true);
        if (!result.structuredContent) throw new Error("missing native response");
        return result.structuredContent;
      };
      if (available) {
        throwing = true;
        await call("setup_status", { module: "investments" });
        expect(contexts).toHaveLength(0);
        throwing = false;
      }
      await call("research_notes");
      await call("upsert_topic_thesis", {
        segment: "energy",
        thesis: "Podaż pozostaje ograniczona przez czas budowy nowych mocy.",
      });
      await call("set_topic_market_view", {
        segment: "energy",
        assessment: "Wykorzystanie mocy jest wysokie, a nowe projekty potrzebują czasu.",
        outlook:
          "Według raportu popyt na energię wzrośnie o 5% do 2028 r.; ryzykiem pozostają ograniczenia podaży.",
        sources: [
          {
            url: "https://example.com/synthetic-industry",
            publisher: "Synthetic filings",
            published_at: "2026-11-01",
          },
        ],
      });
      await call("set_instrument_segment", { instrument: "ABC", segment: "energy" });
      let ref = encodeEntityRef("instrument", instrument);
      if (available) {
        const beforeContexts = contexts.length;
        const context = await call("research_context");
        expect(contexts).toHaveLength(beforeContexts + 1);
        expect(context.as_of).toBe("2026-11-01");
        const rows = context.positions as Json[];
        expect(rows).toHaveLength(1);
        expect(rows[0]?.instrument_id).toBe(ref);
        if (typeof rows[0]?.instrument_id !== "string") throw new Error("missing instrument ref");
        ref = rows[0].instrument_id;
      }
      const started = await call("start_research_run", { scope: { instruments: [ref] } });
      expect(typeof started.run_id).toBe("string");
      expect(
        listed.tools.find((row) => row.name === "finish_research_run")?.inputSchema.properties
          .run_id?.type,
      ).toBe("string");
      if (available) {
        const added = await call("add_research_note", {
          run_id: started.run_id,
          instrument: ref,
          kind: "news",
          polarity: "negative",
          strength: 2,
          thesis_relation: "invalidates",
          thesis_field: "thesis",
          title: "Zakończono program współpracy operacyjnej",
          summary: "Spółka zakończyła program współpracy, który stanowił podstawę opisanej tezy.",
          sources: [
            {
              url: "https://example.com/synthetic-disclosure",
              publisher: "Synthetic filings",
              published_at: "2026-11-01",
            },
          ],
        });
        expect(added.run_id).toBe(started.run_id);
        expect(
          bound.store
            .read<{ rule_id: string }>("SELECT rule_id FROM inv_signals")
            .map((row) => row.rule_id)
            .sort(),
        ).toEqual(["plan:plan_vs_thesis", "research:news"]);
        foreign = await startLocalHost({
          ...testHostOptions(tempDir()),
          now: () => now,
          launcher: false,
          python: null,
          runtime: { ...currentRuntime(), checkout: undefined },
        });
        const foreignVault = [...foreign.stores.vaults.values()][0];
        if (!foreignVault) throw new Error("missing foreign synthetic vault");
        const foreignRun = await foreignVault.queue.run(() => {
          const enabled = runCommand(
            foreignVault.store,
            foreignVault.writer,
            setModules,
            { moduleIds: ["investments"] },
            foreignVault.env,
          );
          if (!enabled.ok) throw new Error(enabled.reason);
          const out = runCommand(
            foreignVault.store,
            foreignVault.writer,
            R.startResearchRun,
            {},
            foreignVault.env,
          );
          if (!out.ok) throw new Error(out.reason);
          return out.value.run;
        });
        const refused = await client.call("tools/call", {
          name: "finish_research_run",
          arguments: { run_id: encodeEntityRef("run", foreignRun) },
        });
        expect((refused.result as Json).isError).toBe(true);
        const wrongKind = await client.call("tools/call", {
          name: "finish_research_run",
          arguments: { run_id: encodeEntityRef("note", foreignRun) },
        });
        expect((wrongKind.result as Json).isError).toBe(true);
      }
      const finished = await call("finish_research_run", { run_id: started.run_id });
      expect(finished.run_id).toBe(started.run_id);
      expect(finished.status).toBe("done");
      if (available) {
        now += 86_400_000;
        expect((await call("research_context")).as_of).toBe("2026-11-02");
        expect(contexts).toContain("2026-11-02");
        const before = bound.store.foreignEvents(0, new Set(), 1000).events.length;
        mismatched = true;
        const refused = await client.call("tools/call", {
          name: "add_research_note",
          arguments: {
            instrument: ref,
            kind: "news",
            polarity: "neutral",
            strength: 1,
            title: "Inny komunikat dotyczący działalności",
            summary:
              "Opublikowano syntetyczny komunikat dotyczący zakresu prowadzonej działalności.",
            sources: [
              {
                url: "https://example.com/other-disclosure",
                publisher: "Synthetic filings",
                published_at: "2026-11-01",
              },
            ],
          },
        });
        expect((refused.result as Json).isError).toBe(true);
        expect(bound.store.foreignEvents(0, new Set(), 1000).events).toHaveLength(before);
      }
      expect(spy).not.toHaveBeenCalled();
    } finally {
      conn?.close();
      await foreign?.stop();
      await host.stop();
    }
  },
);
