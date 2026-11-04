// The invest commands over native stores. Byte expectations were frozen from the retired Python CLI:
// fixtures/fileReports.json (alert catalog and file reports) and fixtures/views.json (positions,
// search and performance rendered by Python from the same native view data, plain and terminal).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { D, parseDateTime } from "@cashu/domain";
import { market, toCurrency } from "@cashu/domain/investments";
import { createTranslator } from "@cashu/i18n";
import { investmentsCommands, runCommand, setModules } from "@cashu/store";
import { PerformanceService } from "@cashu/store/investments/performance";
import { afterEach, expect, it } from "vitest";
import { startLocalHost } from "../../host.js";
import { cleanup, tempDir, testHostOptions } from "../../testing/harness.js";
import { type CommandIo, runTree } from "../tree.js";
import fileReports from "./fixtures/fileReports.json" with { type: "json" };
import views from "./fixtures/views.json" with { type: "json" };
import { investmentCommands } from "./index.js";

afterEach(cleanup);

function io(
  cwd: string,
  terminal = false,
): { io: CommandIo; output: { stdout: string; stderr: string } } {
  const output = { stdout: "", stderr: "" };
  return {
    output,
    io: {
      cwd,
      env: { CASHU_LANG: "en", ...(terminal ? { FORCE_COLOR: "1", COLUMNS: "120" } : {}) },
      tty: { stdin: false, stdout: terminal, stderr: false, columns: terminal ? 120 : 80 },
      signal: new AbortController().signal,
      t: createTranslator("en"),
      stdout: (text) => {
        output.stdout += text;
      },
      stderr: (text) => {
        output.stderr += text;
      },
      prompt: async () => null,
      stdin: async function* () {},
    },
  };
}

it("matches the frozen Python alert catalog and invalid file report bytes", async () => {
  const cwd = tempDir();
  writeFileSync(join(cwd, "invalid.csv"), "synthetic,header\n");
  writeFileSync(
    join(cwd, "valid.csv"),
    "format_version,record,date,type,currency,cash_amount\n1,txn,2026-10-31,deposit,PLN,100\n",
  );
  writeFileSync(join(cwd, "broken.yaml"), "version: [\n");
  writeFileSync(
    join(cwd, "mapping.yaml"),
    "version: 1\ndefault_currency: PLN\ncolumns:\n  trade_date: Date\n  type: Type\n  cash_amount: Amount\n",
  );
  writeFileSync(join(cwd, "mapped.csv"), "Date,Type,Amount\n2026-10-31,deposit,123.45\n");
  const deps = {
    stores: { vaults: new Map() },
    now: () => new Date(2026, 9, 31, 12).getTime(),
    sources: {},
    performance: new PerformanceService(),
  };
  const cases = [
    ["alerts", "kinds"],
    ["validate", "invalid.csv"],
    ["validate", "valid.csv"],
    ["validate", "valid.csv", "--mapping", "broken.yaml"],
    ["validate", "mapped.csv", "--mapping", "mapping.yaml"],
  ].flatMap((args) => [false, true].map((terminal) => ({ args, terminal })));
  for (const [index, { args, terminal }] of cases.entries()) {
    const actual = io(cwd, terminal);
    const outcome = await runTree(["invest", ...args], actual.io, investmentCommands(deps));
    expect(outcome.kind).toBe("exit");
    if (outcome.kind !== "exit") continue;
    expect({ code: outcome.code, ...actual.output }, `case ${index}`).toEqual(fileReports[index]);
  }
});

it("renders a folded multi-currency vault with current strategy and market inputs", async () => {
  const host = await startLocalHost({
    ...testHostOptions(tempDir()),
    launcher: false,
  });
  try {
    const vault = [...host.stores.vaults.values()][0];
    if (!vault) throw new Error("missing synthetic vault");
    expect(
      runCommand(vault.store, vault.writer, setModules, { moduleIds: ["investments"] }, vault.env)
        .ok,
    ).toBe(true);
    const prices = new market.InMemoryPriceCache();
    const account = runCommand(
      vault.store,
      vault.writer,
      investmentsCommands.addBrokerageAccount,
      { name: "Synthetic broker", broker: "xtb", currency: "USD" },
      vault.env,
    );
    expect(account.ok).toBe(true);
    if (!account.ok) throw new Error(account.reason);
    expect(account.value.account).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    const deposited = runCommand(
      vault.store,
      vault.writer,
      investmentsCommands.addManualTransaction,
      {
        account: account.value.account,
        type: "deposit",
        tradeDate: "2026-10-01",
        cashAmount: "2000",
        currency: "USD",
      },
      vault.env,
    );
    expect(deposited.ok).toBe(true);
    const second = runCommand(
      vault.store,
      vault.writer,
      investmentsCommands.addBrokerageAccount,
      { name: "Synthetic PLN account", broker: "manual", currency: "PLN" },
      vault.env,
    );
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error(second.reason);
    expect(
      runCommand(
        vault.store,
        vault.writer,
        investmentsCommands.addManualTransaction,
        {
          account: second.value.account,
          type: "deposit",
          tradeDate: "2026-10-03",
          cashAmount: "1234.56",
          currency: "PLN",
        },
        vault.env,
      ).ok,
    ).toBe(true);
    const bought = runCommand(
      vault.store,
      vault.writer,
      investmentsCommands.addManualTransaction,
      {
        account: account.value.account,
        type: "buy",
        tradeDate: "2026-10-02",
        described: {
          name: "Synthetic Equity",
          symbol: "SYN",
          currency: "USD",
          assetClass: "equity",
        },
        quantity: "10",
        price: "100",
        grossAmount: "1000",
        currency: "USD",
        cashAmount: "-1000",
      },
      vault.env,
    );
    expect(bought.ok, bought.ok ? "" : bought.reason).toBe(true);
    if (!bought.ok || !bought.value.instrument) throw new Error("missing synthetic instrument");
    const alias = runCommand(
      vault.store,
      vault.writer,
      investmentsCommands.addInstrumentAliases,
      { instrument: bought.value.instrument, aliases: [{ namespace: "yahoo", value: "SYN" }] },
      vault.env,
    );
    expect(alias.ok).toBe(true);
    const fetched = parseDateTime("2026-10-31T12:00:00Z");
    prices.upsertBars(
      market.marketSymbol("yahoo", "SYN"),
      [
        {
          date: "2026-10-31",
          close: D("120"),
          currency: null,
          fetchedAt: fetched,
          open: null,
          high: null,
          low: null,
          volume: null,
        },
      ],
      fetched,
    );
    prices.upsertRates(
      "nbp",
      toCurrency("USD"),
      [{ date: "2026-10-31", rate: D("4"), fetchedAt: fetched }],
      fetched,
    );
    const source = { subscribe: () => () => {} };
    const deps = {
      stores: host.stores,
      now: () => new Date(2026, 9, 31, 12).getTime(),
      performance: new PerformanceService(),
      sources: {
        strategy: {
          changes: source,
          current: () => ({
            status: "current" as const,
            vault: vault.id,
            generation: "synthetic",
            revision: "synthetic",
            state: {
              state: "missing" as const,
              result: null,
              config: null,
              issues: [],
              inactiveRules: [],
              sha256: null,
              version: null,
              changed: false,
              readError: null,
            },
          }),
        },
        market: { changes: source, current: () => ({ prices }), newestRateDate: () => null },
      },
    };
    const rendered = new Map<string, string>();
    for (const [args, fragment] of [
      [["accounts", "list"], "Brokerage accounts"],
      [["signals"], "No signals."],
      [["signals", "--history"], "No signals."],
    ] as const) {
      const actual = io(tempDir());
      const result = await runTree(
        ["-p", "demo", "invest", ...args],
        actual.io,
        investmentCommands(deps),
      );
      expect(result).toEqual({ kind: "exit", code: 0 });
      expect(actual.output.stdout).toContain(fragment);
    }
    const added = io(tempDir());
    expect(
      await runTree(
        ["-p", "demo", "invest", "accounts", "add", "Synthetic third", "--broker", "xtb"],
        added.io,
        investmentCommands(deps),
      ),
    ).toEqual({ kind: "exit", code: 0 });
    expect(added.output.stdout).toMatch(
      /Brokerage account 'Synthetic third' \(id [0-9A-HJKMNP-TV-Z]{26}, xtb,\s+regular\)/,
    );
    const strategyFiles = new Map<string, string>();
    const withStrategy = investmentCommands({
      ...deps,
      strategyFiles: () => ({
        read: async (name) => strategyFiles.get(name) ?? null,
        exists: async (name) => strategyFiles.has(name),
        write: async (name, text) => {
          strategyFiles.set(name, text);
        },
        createAbsent: async (name, text) => {
          if (strategyFiles.has(name)) return "exists" as const;
          strategyFiles.set(name, text);
          return "created" as const;
        },
      }),
    });
    const initialized = io(tempDir());
    expect(
      await runTree(["-p", "demo", "invest", "strategy", "init"], initialized.io, withStrategy),
    ).toEqual({ kind: "exit", code: 0 });
    expect(strategyFiles.has("strategy.yaml")).toBe(true);
    const validated = io(tempDir());
    expect(
      await runTree(["-p", "demo", "invest", "strategy", "validate"], validated.io, withStrategy),
    ).toEqual({ kind: "exit", code: 0 });
    expect(validated.output.stdout).toContain("strategy.yaml: valid");
    const polish = io(tempDir());
    const polishIo = { ...polish.io, t: createTranslator("pl") };
    expect(
      await runTree(["-p", "demo", "invest", "signals"], polishIo, investmentCommands(deps)),
    ).toEqual({ kind: "exit", code: 0 });
    expect(polish.output.stdout).toContain("Brak sygnałów.");
    for (const [args, fragment] of [
      [["positions"], "Positions as of"],
      [["performance", "--range", "1m", "--attribution"], "portfolio"],
      [["search", "--local", "syn"], "Synthetic Equity"],
    ] as const) {
      const actual = io(tempDir());
      const result = await runTree(
        ["-p", "demo", "invest", ...args],
        actual.io,
        investmentCommands(deps),
      );
      expect(result).toEqual({ kind: "exit", code: 0 });
      expect(actual.output.stdout).toContain(fragment);
      rendered.set(args[0], actual.output.stdout);
      if (args[0] === "performance") {
        expect(actual.output.stdout).toContain("800.00");
        expect(actual.output.stdout).toContain("top 2 share of P/L");
      }
    }
    {
      const { plain, terminal } = views;
      expect(rendered.get("positions")).toBe(plain[0]);
      const terminalPositions = io(tempDir(), true);
      expect(
        await runTree(
          ["-p", "demo", "invest", "positions"],
          terminalPositions.io,
          investmentCommands(deps),
        ),
      ).toEqual({ kind: "exit", code: 0 });
      expect(terminalPositions.output.stdout).toBe(terminal[0]);
      const scopedPositions = io(tempDir());
      expect(
        await runTree(
          ["-p", "demo", "invest", "positions", "--account", account.value.account],
          scopedPositions.io,
          investmentCommands(deps),
        ),
      ).toEqual({ kind: "exit", code: 0 });
      expect(scopedPositions.output.stdout).toContain("broker");
      expect(scopedPositions.output.stdout).not.toContain("account");
      const scopedPerformance = io(tempDir());
      expect(
        await runTree(
          ["-p", "demo", "invest", "performance", "--account", account.value.account],
          scopedPerformance.io,
          investmentCommands(deps),
        ),
      ).toEqual({ kind: "exit", code: 0 });
      expect(rendered.get("search")).toBe(plain[1]);
      const terminalSearch = io(tempDir(), true);
      expect(
        await runTree(
          ["-p", "demo", "invest", "search", "--local", "syn"],
          terminalSearch.io,
          investmentCommands(deps),
        ),
      ).toEqual({ kind: "exit", code: 0 });
      expect(terminalSearch.output.stdout).toBe(terminal[1]);
      expect(rendered.get("performance")).toBe(plain[2]);
      const terminalPerformance = io(tempDir(), true);
      expect(
        await runTree(
          ["-p", "demo", "invest", "performance", "--range", "1m", "--attribution"],
          terminalPerformance.io,
          investmentCommands(deps),
        ),
      ).toEqual({ kind: "exit", code: 0 });
      expect(terminalPerformance.output.stdout).toBe(terminal[2]);
    }
    const refused = io(tempDir());
    expect(
      await runTree(
        ["-p", "demo", "invest", "positions", "--account", "1"],
        refused.io,
        investmentCommands(deps),
      ),
    ).toEqual({ kind: "exit", code: 2 });
    expect(refused.output.stdout).toBe("");
    expect(refused.output.stderr).not.toBe("");
    for (const args of [
      ["validate", "missing.csv", "--unsupported"],
      ["performance", "--account", "1"],
    ]) {
      const unsupported = io(tempDir());
      expect(
        await runTree(["-p", "demo", "invest", ...args], unsupported.io, investmentCommands(deps)),
      ).toEqual({ kind: "exit", code: 2 });
      expect(unsupported.output.stdout).toBe("");
      expect(unsupported.output.stderr).not.toBe("");
    }
    const offlineSearch = io(tempDir());
    expect(
      await runTree(
        ["-p", "demo", "invest", "search", "syn"],
        offlineSearch.io,
        investmentCommands(deps),
      ),
    ).toEqual({ kind: "exit", code: 0 });
    expect(offlineSearch.output.stdout).toContain("SYN");
    expect(offlineSearch.output.stderr).toContain("Online search is unavailable");
    let remoteCalls = 0;
    const onlineSearch = io(tempDir());
    expect(
      await runTree(
        ["-p", "demo", "invest", "search", "syn"],
        onlineSearch.io,
        investmentCommands({
          ...deps,
          searchIo: () => ({
            vault: vault.id,
            binding: {},
            isCurrent: () => true,
            async remoteHits() {
              remoteCalls += 1;
              return { hits: [], status: "ok" as const };
            },
          }),
        }),
      ),
    ).toEqual({ kind: "exit", code: 0 });
    expect(remoteCalls).toBe(1);
    expect(onlineSearch.output.stderr).toBe("");
    const ambiguous = io(tempDir());
    expect(
      await runTree(
        ["-p", "demo", "invest", "positions"],
        ambiguous.io,
        investmentCommands({
          ...deps,
          stores: {
            vaults: new Map([
              ["one", vault],
              ["two", vault],
            ]),
          },
        }),
      ),
    ).toEqual({ kind: "exit", code: 2 });
    expect(ambiguous.output.stdout).toBe("");
    expect(ambiguous.output.stderr).not.toBe("");
  } finally {
    await host.stop();
  }
});
