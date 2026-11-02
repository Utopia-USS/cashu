# @cashu/parity

Compares a TypeScript output dir against the Python goldens (`parity/README.md`, scope S02).
Scope S03 of the TS migration.

```bash
pnpm parity --dataset demo --actual parity/golden-demo      # synthetic goldens, committed
pnpm parity --dataset lab --actual <dir> [--check core.*]   # real-data goldens, never printed
pnpm parity:produce --dataset demo [--check core.networth]  # TS producers -> <lab>/parity/ts-out/demo
pnpm parity --dataset demo --check core.networth            # compare (default actual = ts-out)
```

Output per check: `pass` / `fail` / `missing`, row counts, short sha256 of the golden and actual
files and, on failure, the JSON path and kind of the **first** difference. Values are never printed
(the lab goldens are real data). A missing actual dir or file gives `missing`; byte-identical files
pass without parsing (`--deep` forces the tree comparison). Exit code: 0 all pass, 1 a check
failed, 2 only missing (`--allow-missing` turns that into 0), 64 usage, 70 golden/config problem or
stale inputs (below).

Defaults: lab goldens `~/cashu-lab/parity/out/lab` (`$CASHU_LAB_DIR` moves the lab root), demo
goldens `parity/golden-demo`, actual `~/cashu-lab/parity/ts-out/<dataset>`.

Branch runs: the shared `~/cashu-lab/parity/out` and `ts-out` dirs are written from
lab/ts-stack HEAD only. A branch writes its own set and points every step at it:

```bash
PARITY_BRANCH_ROOT=~/cashu-lab/parity/out-<branch>
.venv/bin/python parity/python/golden.py --dataset lab --out $PARITY_BRANCH_ROOT
pnpm parity:produce --dataset lab --golden-root $PARITY_BRANCH_ROOT --out $PARITY_BRANCH_ROOT/ts-out/lab
pnpm parity --dataset lab --out $PARITY_BRANCH_ROOT --actual $PARITY_BRANCH_ROOT/ts-out/lab
```

MCP name sources now come from the real native providers over genesis-folded vaults; the guard
bridge and `--bridge-mcp` option are removed. The five S38b dataset reads (`spending_breakdown`,
`cashflow_summary`, `recurring_payments`, `uncategorized_merchants`, `loans_summary`) execute actual
native handlers against folded vaults, including independent module/error handling and the real
privacy boundary. Only after leak checking, typed loan references map through genesis identities
to the oracle's natural keys; production wire references remain opaque gids, not Python integers.
The seven S38c financial read methods also execute native handlers: `portfolio_overview`, `positions`,
`signals` (all three statuses), `review_context`, `strategy_status`, `history_metrics`, and `theses`.
Their view/history ports use actual copied market facts and native calculations, never labelled
answer replay. Investment refs are normalized through validated source identities only after the
unchanged redactor and leak check. The declared `rule` field keeps Python's literal `alert:<counter>`
spelling after this normalization; production uses opaque native alert refs. Thus identity-normalized
parity bytes do not claim identical production identifiers.
Remaining unported reads and native core reads still replay Python labelled trees to prove
provider/redactor equivalence. Focused handler and real host tests cover native core separately.
File inspection and both validators use actual Python synthetic file/host tests; dataset checks do
not supply file paths. The blocked category writer is not read parity.
Mixed Python/native hosts retain the five financial reads on Python until write/ingestion contracts
are resolved, preserving coherent merchant references and read-after-write results. Native-only
hosts expose the five reads without the unavailable writer. Dataset parity exercises native bodies
regardless of that temporary routing choice.
Mixed hosts also keep financial investment reads with the Python writer. Native-only hosts expose
stored signals/theses; calculated investment views and history require explicit coherent per-call
market/strategy dependencies. File tools require the existing checked legacy-path authority. No
dummy cache or fabricated successful calendar refresh enables production routing.
`mcp.tool_schemas` uses native specs plus the generated contracts of remaining Python tools, in
the exact Python registry order, with native module gating. Host integration
tests compare the complete actual SDK tool list. Regenerate delegated contracts with
`scripts/gen_mcp_tool_metadata.py` when Python registry metadata changes, then format/check normally.

## Staleness guard

A comparison is only meaningful when every input comes from the commit under test, so `pnpm parity`
checks that first (`src/staleness.ts`). The commit under test is the git HEAD of the tree the comparer
runs from. Every producer records its source commit and `dirty` (tracked files differed from HEAD)
in its `index.json`:

- `golden.py`: `commit` / `dirty` at
  the top of the dir's index (`golden.child_env`).
- `pnpm parity:produce`: per check in the TS output dir's index, with the Python-side dirs the check
  read (`inputs`: `golden`) and the commits their indexes
  recorded at that moment. A `--check` run updates only its own entries; a failed check's old file
  and entry are removed.

The run is refused (exit 70, nothing compared) when the golden dir, a compared TS output or one of its
inputs has no index, records no commit or records another commit than HEAD (an input is checked both
as the producer read it and as it is now). The message names each dir, the check and the recorded
commit. A golden set committed in the repo (`parity/golden-demo`, also the demo MCP producers' raw
input) cannot record its own commit; it is compared check by check with the shared
`<lab>/parity/out/<dataset>` when that is at HEAD, refused when they differ, and noted as not
cross-checked otherwise. A dirty producer is noted, not refused (the usual state while porting).

`--allow-stale` compares anyway: the list of stale inputs is printed as a `!!` banner before and after
the table (stderr with `--json`, where `staleness` is also part of the report). Use it only to look
at a known-stale set; a result produced with it is never a parity result. The fix for a refusal is
to regenerate the named dirs from the commit under test (the commands above, or the shared ones from
lab/ts-stack HEAD).

## Comparison rules

- Objects are unordered, arrays ordered. Duplicate keys and `NaN` literals are parse errors.
- Integers are exact (`bigint`). Floats: equal when `|a-b| <= absTol` or `<= relTol * max(|a|,|b|)`,
  default `absTol 1e-9`, `relTol 1e-12`. An integer against a float compares as numbers (a TS
  producer cannot write `1.0`).
- Decimal strings (Python `Decimal` as `str()`) feed hashes, so the default is an exact string
  match: `"1.0"` vs `"1.00"` fails. Per check, `"decimal": "numeric"` accepts strings that denote
  the same number (`"1.0"` = `"1.00"`, `"1E+1"` = `"10"`), still with no tolerance. It applies to
  every digit-like string in that check, so use it only where scale is not part of the contract.
- Paths print schema-like keys (`snake_case` fields, `$label`, natural keys, currency codes, ISO
  dates); any other object key could be data and prints as `<key:8 hex of sha256>`. `--hash-keys`
  hashes all keys.

## Tolerance config

`parity.config.json` (override with `--config`); unknown keys and unknown check names are errors:

```json
{
  "default": { "absTol": 1e-9, "relTol": 1e-12, "decimal": "exact" },
  "checks": {
    "investments.performance": { "absTol": 1e-6 },
    "core.networth": { "decimal": "numeric" }
  }
}
```

Precedence: built-in defaults < `default` < `checks.<name>`.

## Sources: the one read-only way into the Python data (`src/sources/`)

Every TS producer reads the Python app's data through `PythonDb` (`src/sources/pythonDb.ts`); a
producer never opens SQLite itself and never carries its own reader.

- `PythonDb.open({ dataset })` copies the dataset's `cashu.db` (+ `-wal` / `-shm`) from its source dir
  (golden.py `DATASETS`: `demo` = `<lab>/parity/demo-data`, `lab` = `<lab>/data`) into a fresh
  `<lab>/parity/ts-run-<stamp>-<pid>-<dataset>/` and opens the copy with `node:sqlite` `readOnly`. The
  source is never opened: even a read-only connection to a WAL database creates `-wal` / `-shm` files
  next to it. `close()` deletes the copy and throws `SourceChangedError` when the source's manifest
  (sha256 over every file, as golden.py) changed. `withPythonDb(opts, fn)` always closes.
- Typed readers per table, profile-scoped: `profiles()` (slug order, the goldens' order),
  `enabledModules(profileId)`, `accounts(profileId, { includeRemoved })`, `balances(profileId)`,
  `transactions(profileId)`; the investments tables under `db.investments` (`src/sources/investments.ts`):
  `brokerageAccounts`, `transactions`, `renames`, `manualValuations`, `profileInstruments` (profile-scoped)
  and the shared reference data `instruments`, `aliases`, `priceBars`, `fxRates`. The loans and assets tables under
  `db.loansAssets` (`src/sources/loansAssets.ts`): `loans`, `depreciations`, `assetDetails` and
  `loanAccountBalances` (with `created_at`), scoped through the profile's accounts (removed ones too). Every reader of profile data takes the profile id. Decimals stay the
  stored text (`"12.50"`, parse with `D()` from `@cashu/domain`), enums stored by NAME come back as
  their values (`balances.source` `CSV` -> `"csv"`), booleans as booleans.
- `db.keys.key(table, id)`: the goldens' natural keys (`src/sources/naturalKeys.ts`, a verbatim copy of
  canon.py `SPECS` / `IdMap`, checked against canon.py by a test). Producers emit these, never row ids.
- `db.asOf`: the dataset's frozen date (golden.py `CLOCKS`, guarded by a test); pass it as `today`.
- A producer needs another table: add a typed reader to `PythonDb` with a test on the synthetic dataset
  (`src/sources/testing.ts`), not ad hoc SQL in the producer.
- Lab rows are real data: written only to `<lab>/parity/ts-out/lab/`, never printed (the producer CLI
  prints check names, row counts, hashes and error class names only).

## Producers (`src/producers/`)

`PRODUCERS` in `src/producers/index.ts` lists one producer per golden check: the check name, the
datasets it is enabled for and `produce(db) -> JSON tree`; `<module>/` folders hold the code
(`core/networth.ts`). `src/producers/output.ts` writes canonical JSON (sorted keys, Decimals through
`toJSON()` = Python `str()`, JS numbers refused). The CLI runs under Node's type stripping with
`tools/node-ts/resolveTs.ts` (shared with the `cashu-next` CLI), which maps the `./x.js` specifiers
of workspace TypeScript to `./x.ts`.

| Check                         | Datasets  | Inputs                                                                                                                                                              |
| ----------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core.networth`               | demo, lab | accounts, balances, cash-pool transactions, loans, curves, investments rows (`PythonDb`): every module contributor in TS (`core/book.ts`)                           |
| `core.networth_series`        | demo, lab | as `core.networth`; daily total, weekly liquid and monthly components per currency of the profile's accounts                                                        |
| `loans.valuation`             | demo, lab | loans and the loan accounts' balances with `created_at` (`db.loansAssets`): `@cashu/domain` loans                                                                   |
| `assets.depreciation`         | demo, lab | as `core.networth` plus curves and notes (`db.loansAssets`): the manual positions list and each curve at the probe dates                                            |
| `budget.dedup`                | demo      | stored transactions (`db.transactions`): v2 hash and occurrence through `@cashu/domain` budget, v1 with `node:crypto`                                               |
| `budget.ingest_fixtures`      | demo      | the synthetic CSV fixtures of `packages/domain/test/fixtures/budget-csv` (not dataset state)                                                                        |
| `budget.transfers`            | demo      | stored transactions in id order and every account incl. removed (`db.transactions`, `db.accounts`): `budget.matchTransfers`, drift from the stored groups           |
| `investments.valuation`       | demo, lab | investments rows (`db.investments`); strategy inputs from the TS strategy loader (`investments/strategy.ts`)                                                        |
| `investments.allocation`      | demo, lab | as `investments.valuation`                                                                                                                                          |
| `investments.performance`     | demo, lab | investments rows, proxy lookup by ISIN / alias (`db.investments`); strategy state, policy, plan, benchmark from the TS strategy loader                              |
| `investments.strategy_loader` | demo, lab | `profiles/<slug>/strategy.{yaml,md}` of the copy (`db.files()`), the newest `inv_strategy_versions` row: state, digest, load result; the shipped templates          |
| `investments.rules`           | demo, lab | native strategy/context/engine and all nine pure kinds over the copied portfolio inputs, without Python outcome inputs                                              |
| `investments.signals`         | demo, lab | typed copied-source signal, run, decision and link rows: native open/history/all serialization, labels, snooze/current flags and payload/message helpers            |
| `investments.import_plan`     | demo, lab | import batches, the account's mapping, stored instruments / aliases / hashes (`db.investments`); the archived files through `db.dataFile` (copied into the run dir) |

`investments/portfolioState.ts` is the port of `service/portfolio.build`: rows -> domain values as the
Python store converts them (`investments/rows.ts`, domain ids are the app's `str(pk)` because the
portfolio math breaks ties in Python `str` order of ids; `serialize.ts` maps them to natural keys when
writing), then `buildSnapshot` -> `valuePortfolio` -> `allocate` from `@cashu/domain`. Floats Python
writes as floats are wrapped with `pyFloat()` (`output.ts`). Not produced here: `investments.allocation_view`
(the views, S22a; the pure allocation_drift rule is already ported), `investments.positions` / `position_detail` (views,
S22a; their lots and realized trades are the same values `investments.valuation` already checks:
`snapshot.holdings[].lots`, `snapshot.realized`, `valued.realized`).

`investments/signals.ts` genuinely computes the stored signal views from typed copied-source rows;
it never consumes Python result trees. Dataset parity checks the existing open/history/all views,
not a lifecycle rerun. Independent synthetic Python differential cases and engine-to-lifecycle-to-store
tests prove reconciliation and persistence, including canonical merged identities and one command
batch. This distinction keeps stored-view parity separate from the lifecycle execution proof.

`investments/performance.ts` is the port of `performance/service.load` (rows -> domain values as
`rows.ts`, `find_proxy` over `instrumentIdByIsin` / `instrumentIdByAlias`, bars and rates from 14 days
before the first transaction) feeding the `@cashu/domain` performance service (S19a core, S19b
service: `computePerformance`, `performanceView`, `attributionView`), the same functions the store's
performance service (`@cashu/store` `investmentsPerformance`) runs over a vault and the device's price
cache. `investments/performanceOut.ts` writes the typed views in the golden's form (Python ints by
key, other numbers as floats, ids as dataset keys). The store loading path itself is checked once
genesis (S26) can build a vault from a dataset: then the producer reads the vault instead of the
Python database. Tolerance: the check has no Decimal strings (every number is a Python
float rounded by `_money` / `_ratio`), so it runs on the S03 float default (abs 1e-9 / rel 1e-12); it
passes byte-identical on demo and lab, because the TS core repeats Python's float operations in the
same order (incl. CPython's compensated `sum()`, `floats.ts`). `exp` / `expm1` / `**` are V8's fdlibm
ports against the platform libm in CPython: should a last-bit difference ever flip a rounding, that
is the place to look (do not widen the tolerance to hide it).

### Strategy: the TS loader

`investments/strategy.ts` reads a profile's strategy files from the dataset copy like
`service/strategy.read_files` (strict UTF-8 with universal newlines, the size cap) and the newest
stored version, then runs `@cashu/domain`'s `strategyStatus` (the loader on the PyYAML compose port, the
rule kinds' params, the custom-expression compiler). The portfolio, performance and month close
producers take their strategy inputs from it (the S14 strategy bridge is gone);
`investments/strategyLoader.ts` writes `investments.strategy_loader` (every profile's state and load
result, the templates). `investments.strategy_status` is a view with paths and versions (S22a).

### Net worth: every contributor in TS

Net worth asks every module's contributor; all four run in TS over the source's rows (`core/book.ts`):
budget's cash pool (`budget.cashContributor`, S08), assets' depreciation curves
(`assets.assetsContributor`, S11), loans' amortization anchored on balances recorded after the terms
(`loans.loansContributor`, S11) and investments' brokerage valuation (`BrokerageContributor`, S13).
Everything core owns (balance snapshots and their source rank, contributor precedence, signs, per
currency totals, breakdown, the history series) is `@cashu/domain` core. The temporary Python bridge
that supplied the loans / assets values until S11 is gone.
