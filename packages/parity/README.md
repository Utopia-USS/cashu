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

Branch runs: the shared `~/cashu-lab/parity/out`, `bridge-mcp` and `ts-out` dirs are written from
lab/ts-stack HEAD only. A branch writes its own set and points every step at it:

```bash
B=~/cashu-lab/parity/out-<branch>
.venv/bin/python parity/python/golden.py --dataset lab --out $B             # $B/lab, index.json records the commit
.venv/bin/python packages/parity/src/producers/mcp/guard_bridge.py --dataset lab --out $B/bridge-mcp
pnpm parity:produce --dataset lab --golden-root $B --bridge-mcp $B/bridge-mcp --out $B/ts-out/lab
pnpm parity --dataset lab --out $B --actual $B/ts-out/lab                    # golden = $B/lab
```

## Staleness guard

A comparison is only meaningful when every input comes from the commit under test, so `pnpm parity`
checks that first (`src/staleness.ts`). The commit under test is the git HEAD of the tree the comparer
runs from. Every producer records its source commit and `dirty` (tracked files differed from HEAD)
in its `index.json`:

- `golden.py`, `guard_bridge.py`, `networth_bridge.py`, `strategy_bridge.py`: `commit` / `dirty` at
  the top of the dir's index (`golden.child_env`).
- `pnpm parity:produce`: per check in the TS output dir's index, with the Python-side dirs the check
  read (`inputs`: `golden`, `bridge`, `bridge-strategy`, `bridge-mcp`) and the commits their indexes
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
  and the shared reference data `instruments`, `aliases`, `priceBars`, `fxRates`. Every reader of profile data takes the profile id. Decimals stay the
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

| Check                     | Datasets  | Inputs                                                                                                                                                              |
| ------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core.networth`           | demo, lab | accounts, balances, cash-pool transactions, investments rows (`PythonDb`); loans / assets contributors from the bridge                                              |
| `budget.dedup`            | demo      | stored transactions (`db.transactions`): v2 hash and occurrence through `@cashu/domain` budget, v1 with `node:crypto`                                               |
| `budget.ingest_fixtures`  | demo      | the synthetic CSV fixtures of `packages/domain/test/fixtures/budget-csv` (not dataset state)                                                                        |
| `investments.valuation`   | demo, lab | investments rows (`db.investments`); strategy inputs from the strategy bridge                                                                                       |
| `investments.allocation`  | demo, lab | as `investments.valuation`                                                                                                                                          |
| `investments.performance` | demo, lab | investments rows, proxy lookup by ISIN / alias (`db.investments`); strategy state, policy, plan, benchmark from the strategy bridge                                 |
| `investments.import_plan` | demo, lab | import batches, the account's mapping, stored instruments / aliases / hashes (`db.investments`); the archived files through `db.dataFile` (copied into the run dir) |

`investments/portfolioState.ts` is the port of `service/portfolio.build`: rows -> domain values as the
Python store converts them (`investments/rows.ts`, domain ids are the app's `str(pk)` because the
portfolio math breaks ties in Python `str` order of ids; `serialize.ts` maps them to natural keys when
writing), then `buildSnapshot` -> `valuePortfolio` -> `allocate` from `@cashu/domain`. Floats Python
writes as floats are wrapped with `pyFloat()` (`output.ts`). Not produced here: `investments.allocation_view`
(the allocation_drift rule, S15b, and the views, S22a), `investments.positions` / `position_detail` (views,
S22a; their lots and realized trades are the same values `investments.valuation` already checks:
`snapshot.holdings[].lots`, `snapshot.realized`, `valued.realized`).

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

### Temporary strategy bridge (S14)

The strategy loader is not ported yet, so `src/producers/investments/strategy_bridge.py` exports what
`build` takes from a profile's strategy (base currency, `data` thresholds, allocation plan; for
performance also the strategy state and the benchmark id / proxy) to
`<lab>/parity/bridge-strategy/<dataset>/investments.strategy.json`, through golden.py's harness:

```bash
.venv/bin/python packages/parity/src/producers/investments/strategy_bridge.py --dataset lab
```

Delete it (and `strategyBridge.ts`) when the TS strategy loader lands; both carry the S14 transitional marker.

### Temporary bridge for contributors not ported yet

Net worth asks every module's contributor. The investments contributor is the domain
`BrokerageContributor` (S13) over the profile's investments rows (`investments/brokerage.ts`). Until
loans and assets (S11) are ported, `src/producers/core/networth_bridge.py` exports only those
contributors' results (accounts
each values, `latest()` now and at as_of - 365 days), through golden.py's harness (run copy, offline,
frozen clock), to `<lab>/parity/bridge/<dataset>/core.networth_contributors.json`:

```bash
.venv/bin/python packages/parity/src/producers/core/networth_bridge.py --dataset demo
```

Everything core owns (balance snapshots and their source rank, contributor precedence, signs, per
currency totals, breakdown) is recomputed in TS; the cash pool runs through budget's domain
contributor (`budget.cashContributor`, S08). When a module's TS contributor lands,
drop it from `BRIDGED` / `BRIDGED_MODULES`; delete the bridge with the last one.

`core.networth` runs on `demo` and `lab`. `core.networth_series` needs `at()` / `axisDates()` of the
bridged contributors, so it waits for S11 (the brokerage contributor has them since S13).
