import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { D, parseDateTime } from "@cashu/domain";
import { asProfileId, market, performance as perf, toCurrency } from "@cashu/domain/investments";
import { createTranslator } from "@cashu/i18n";
import { investmentsCommands, runCommand, setModules } from "@cashu/store";
import { PerformanceService } from "@cashu/store/investments/performance";
import { projectInstrumentSearch } from "@cashu/store/investments/services";
import { readPositions } from "@cashu/store/investments/views";
import { afterEach, expect, it } from "vitest";
import { startLocalHost } from "../../host.js";
import { cleanup, tempDir, testHostOptions } from "../../testing/harness.js";
import { type CommandIo, runTree } from "../tree.js";
import { investmentCommands } from "./index.js";

const REPO = fileURLToPath(new URL("../../../../../", import.meta.url));
const PYTHON = join(REPO, ".venv", "bin", "python");
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

function python(
  cases: readonly { readonly args: readonly string[]; readonly terminal: boolean }[],
  cwd: string,
) {
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: tempDir(),
    CASHU_TESTING: "1",
    CASHU_DATA_DIR: tempDir(),
    CASHU_WORKSPACES_DIR: tempDir(),
    CASHU_AUTO_DAILY: "0",
    CASHU_LANG: "en",
    LANG: "en_US.UTF-8",
    PYTHONPATH: join(REPO, "src"),
  };
  const code = `import json,sys,os\nfrom typer.testing import CliRunner\nfrom cashu.cli import app\nrunner=CliRunner()\nout=[]\nfor case in json.loads(sys.argv[1]):\n    if case['terminal']:\n        os.environ['FORCE_COLOR']='1'\n        os.environ['COLUMNS']='120'\n    else:\n        os.environ.pop('FORCE_COLOR',None)\n        os.environ.pop('COLUMNS',None)\n    r=runner.invoke(app,case['args'],color=case['terminal'])\n    out.append({'code':r.exit_code,'stdout':r.stdout,'stderr':r.stderr})\nprint(json.dumps(out))`;
  const result = spawnSync(PYTHON, ["-c", code, JSON.stringify(cases)], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as { code: number; stdout: string; stderr: string }[];
}

function pythonRender(
  kind: "positions" | "performance" | "search",
  data: unknown,
  cwd: string,
  terminal = false,
): string {
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: tempDir(),
    CASHU_TESTING: "1",
    CASHU_DATA_DIR: tempDir(),
    CASHU_WORKSPACES_DIR: tempDir(),
    CASHU_AUTO_DAILY: "0",
    PYTHONPATH: join(REPO, "src"),
    CASHU_LANG: "en",
    LANG: "en_US.UTF-8",
    ...(terminal ? { FORCE_COLOR: "1", COLUMNS: "120" } : {}),
  };
  const code = `import json,sys,io,contextlib
from rich.console import Console
from cashu.core import cliutil
import cashu.modules.investments.cli as c
import cashu.modules.investments.performance.cli as p
import cashu.modules.investments.cli_alerts as a
from cashu.modules.investments.service import views
from cashu.modules.investments.performance import service
from cashu.modules.investments.service import instrument_search
from types import SimpleNamespace
kind,data=json.loads(sys.stdin.read())
out=io.StringIO()
cliutil.console=Console(file=out,force_terminal=${terminal ? "True" : "False"},width=${terminal ? 120 : 80},color_system=${terminal ? "'standard'" : "None"})
cliutil.profile=lambda session,create=False: object()
c.init_db=lambda:None
c.get_session=lambda:contextlib.nullcontext(object())
p.init_db=lambda:None
p.get_session=lambda:contextlib.nullcontext(object())
views.account_filter=lambda session,profile,account:None
if kind=='positions':
    views.positions=lambda *args,**kwargs:data
    c.positions_cmd()
elif kind=='search':
    a.init_db=lambda:None
    a.get_session=lambda:contextlib.nullcontext(object())
    instrument_search.search_detached=lambda *args,**kwargs:SimpleNamespace(query=data['query'],local=[SimpleNamespace(**hit) for hit in data['local']],remote=[],remote_status='skipped')
    a.search_cmd('syn',True)
else:
    service.performance_view=lambda *args,**kwargs:data['view']
    service.attribution_view=lambda *args,**kwargs:data['attribution']
    p.performance_cmd('1m',None,True)
print(json.dumps(out.getvalue()))`;
  const run = spawnSync(PYTHON, ["-c", code], {
    cwd,
    env,
    input: JSON.stringify([kind, data]),
    encoding: "utf8",
    timeout: 30_000,
  });
  expect(run.status, run.stderr).toBe(0);
  return JSON.parse(run.stdout) as string;
}

it.skipIf(!existsSync(PYTHON))(
  "matches Python alert catalog and invalid file report bytes",
  async () => {
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
    const expected = python(
      cases.map((entry) => ({ ...entry, args: ["invest", ...entry.args] })),
      cwd,
    );
    for (const [index, { args, terminal }] of cases.entries()) {
      const actual = io(cwd, terminal);
      const outcome = await runTree(["invest", ...args], actual.io, investmentCommands(deps), {});
      expect(outcome.kind).toBe("exit");
      if (outcome.kind !== "exit") continue;
      expect({ code: outcome.code, ...actual.output }, `case ${index}`).toEqual(expected[index]);
    }
  },
);

it("renders a folded multi-currency vault with current strategy and market inputs", async () => {
  const host = await startLocalHost({
    ...testHostOptions(tempDir()),
    python: null,
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
      [["positions"], "Positions as of"],
      [["performance", "--range", "1m", "--attribution"], "portfolio"],
      [["search", "--local", "syn"], "Synthetic Equity"],
    ] as const) {
      const actual = io(tempDir());
      const result = await runTree(
        ["-p", "demo", "invest", ...args],
        actual.io,
        investmentCommands(deps),
        {},
      );
      expect(result).toEqual({ kind: "exit", code: 0 });
      expect(actual.output.stdout).toContain(fragment);
      rendered.set(args[0], actual.output.stdout);
      if (args[0] === "performance") {
        expect(actual.output.stdout).toContain("800.00");
        expect(actual.output.stdout).toContain("top 2 share of P/L");
      }
    }
    if (existsSync(PYTHON)) {
      const read = vault.store.read.bind(vault.store);
      const positionView = readPositions(read, {
        prices,
        vault: asProfileId(vault.id),
        asOf: "2026-10-31",
        clock: {
          today: "2026-10-31",
          now: fetched,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
        strategy: deps.sources.strategy.current().state,
        lang: "en",
        forOwner: true,
      });
      expect(positionView.ok).toBe(true);
      if (!positionView.ok) throw new Error(positionView.reason);
      const positionData = {
        as_of: positionView.value.as_of,
        base_currency: positionView.value.base_currency,
        positions: positionView.value.positions.map((row) => ({
          instrument: { label: row.instrument.label, asset_class: row.instrument.asset_class },
          quantity: row.quantity.toFloat(),
          price: row.price?.toFloat() ?? null,
          price_currency: row.price_currency,
          price_date: row.price_date,
          is_stale: row.is_stale,
          value: row.value?.toFloat() ?? null,
          weight: row.weight,
          unrealized_pct: row.unrealized_pct,
        })),
        cash: positionView.value.cash.map((cash) => ({
          account_name: cash.account_name,
          amount: cash.amount.toFloat(),
          currency: cash.currency,
          amount_base: cash.amount_base?.toFloat() ?? null,
        })),
        total: positionView.value.total.toFloat(),
      };
      expect(rendered.get("positions")).toBe(pythonRender("positions", positionData, tempDir()));
      const terminalPositions = io(tempDir(), true);
      expect(
        await runTree(
          ["-p", "demo", "invest", "positions"],
          terminalPositions.io,
          investmentCommands(deps),
          {},
        ),
      ).toEqual({ kind: "exit", code: 0 });
      expect(terminalPositions.output.stdout).toBe(
        pythonRender("positions", positionData, tempDir(), true),
      );
      const search = projectInstrumentSearch({ read, asOf: "2026-10-31" }, "syn");
      expect(search.local).toHaveLength(1);
      expect(rendered.get("search")).toBe(pythonRender("search", search, tempDir()));
      const terminalSearch = io(tempDir(), true);
      expect(
        await runTree(
          ["-p", "demo", "invest", "search", "--local", "syn"],
          terminalSearch.io,
          investmentCommands(deps),
          {},
        ),
      ).toEqual({ kind: "exit", code: 0 });
      expect(terminalSearch.output.stdout).toBe(pythonRender("search", search, tempDir(), true));
      const request = {
        prices,
        asOf: "2026-10-31",
        strategy: {
          state: "missing" as const,
          benchmark: null,
          policy: perf.DEFAULT_VALUATION_POLICY,
          strategy: null,
        },
        range: "1m",
      };
      const view = deps.performance.performanceView(vault.store, request);
      const attribution = deps.performance.attributionView(vault.store, request);
      expect(view.ok && attribution.ok).toBe(true);
      if (!view.ok || !attribution.ok) throw new Error("missing synthetic performance");
      expect(rendered.get("performance")).toBe(
        pythonRender(
          "performance",
          { view: view.value, attribution: attribution.value },
          tempDir(),
        ),
      );
      const terminalPerformance = io(tempDir(), true);
      expect(
        await runTree(
          ["-p", "demo", "invest", "performance", "--range", "1m", "--attribution"],
          terminalPerformance.io,
          investmentCommands(deps),
          {},
        ),
      ).toEqual({ kind: "exit", code: 0 });
      expect(terminalPerformance.output.stdout).toBe(
        pythonRender(
          "performance",
          { view: view.value, attribution: attribution.value },
          tempDir(),
          true,
        ),
      );
    }
    const refused = io(tempDir());
    expect(
      await runTree(
        ["-p", "demo", "invest", "positions", "--account", "1"],
        refused.io,
        investmentCommands(deps),
        {},
      ),
    ).toEqual({ kind: "delegate" });
    expect(refused.output).toEqual({ stdout: "", stderr: "" });
    for (const args of [
      ["validate", "missing.csv", "--unsupported"],
      ["performance", "--account", "1"],
      ["search", "syn"],
    ]) {
      const unsupported = io(tempDir());
      expect(
        await runTree(
          ["-p", "demo", "invest", ...args],
          unsupported.io,
          investmentCommands(deps),
          {},
        ),
      ).toEqual({ kind: "delegate" });
      expect(unsupported.output).toEqual({ stdout: "", stderr: "" });
    }
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
        {},
      ),
    ).toEqual({ kind: "delegate" });
    expect(ambiguous.output).toEqual({ stdout: "", stderr: "" });
  } finally {
    await host.stop();
  }
});
