/** Actual Python API validation oracle; synthetic inputs and isolated paths only. */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createProfile } from "../core/commands.js";
import { runQuery } from "../query.js";
import { run, testEnv } from "../testing/commands.js";
import { openTestStore } from "../testing/store.js";
import { loansScreen } from "./screen.js";
import { createUiLoan } from "./ui-commands.js";

const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const python = join(repo, ".venv/bin/python");
const oracle = `
import json, sys
from cashu.modules.loans.api import LoanCreate, _check
out=[]
for raw in json.load(sys.stdin):
    try:
        body=LoanCreate(**raw)
        name,currency=_check(body,"EUR")
        out.append({"ok":True,"name":name,"currency":currency})
    except Exception:
        out.append({"ok":False})
print(json.dumps(out))
`;
it.skipIf(!existsSync(python))(
  "matches actual API name, currency, term, rate and date checks",
  () => {
    const home = mkdtempSync(join(tmpdir(), "cashu-loan-oracle-"));
    const base = {
      name: " Synthetic   loan ",
      principal: 12000,
      annual_rate: 6.5,
      term_months: 12,
      start_date: "2026-01-31",
      origination_date: null,
      currency: " eur ",
    };
    const cases = [
      {},
      { name: "\u0085Synthetic\u0085loan\u0085" },
      { principal: 0 },
      { principal: -1 },
      { annual_rate: -1 },
      { annual_rate: 100 },
      { annual_rate: 100.1 },
      { term_months: 0 },
      { term_months: 601 },
      { start_date: "2026-02-30" },
      { origination_date: "2026-02-01" },
      { currency: "EURO" },
      { name: "x".repeat(121) },
    ].map((patch) => ({ ...base, ...patch }));
    try {
      const result = spawnSync(python, ["-c", oracle], {
        input: JSON.stringify(cases),
        encoding: "utf8",
        cwd: repo,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: home,
          CASHU_TESTING: "1",
          CASHU_DATA_DIR: join(home, "data"),
          CASHU_WORKSPACES_DIR: join(home, "workspaces"),
          CASHU_AUTO_DAILY: "0",
          PYTHONPATH: join(repo, "src"),
        },
      });
      expect(result.status, result.stderr).toBe(0);
      const expected = JSON.parse(result.stdout) as {
        ok: boolean;
        name?: string;
        currency?: string;
      }[];
      cases.forEach((input, index) => {
        const store = openTestStore();
        const env = testEnv();
        run(store, env, createProfile, {
          slug: "demo",
          name: "Demo",
          baseCurrency: "EUR",
          modules: ["loans"],
        });
        const result = run(store, env, createUiLoan, {
          name: input.name,
          principal: input.principal,
          annualRate: input.annual_rate,
          termMonths: input.term_months,
          startDate: input.start_date,
          originationDate: input.origination_date,
          currency: input.currency,
        });
        expect(result.ok, `case ${index}`).toBe(expected[index]?.ok);
        if (result.ok) {
          const row = runQuery(store, loansScreen, { today: "2026-03-01" }).value[0];
          expect(row?.name).toBe(expected[index]?.name);
          expect(row?.currency).toBe(expected[index]?.currency);
        }
        store.detach();
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);
