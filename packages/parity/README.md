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
failed, 2 only missing (`--allow-missing` turns that into 0), 64 usage, 70 golden/config problem.

Defaults: lab goldens `~/cashu-lab/parity/out/lab` (`$CASHU_LAB_DIR` moves the lab root), demo
goldens `parity/golden-demo`, actual `~/cashu-lab/parity/ts-out/<dataset>`.

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
`src/producers/resolveTs.ts`, which maps the `./x.js` specifiers of workspace TypeScript to `./x.ts`.

| Check                    | Datasets  | Inputs                                                                                                             |
| ------------------------ | --------- | ------------------------------------------------------------------------------------------------------------------ |
| `core.networth`          | demo      | accounts, balances, cash-pool transactions (`PythonDb`); loans / assets / investments contributors from the bridge |
| `investments.valuation`  | demo, lab | investments rows (`db.investments`); strategy inputs from the strategy bridge                                      |
| `investments.allocation` | demo, lab | as `investments.valuation`                                                                                         |

`investments/portfolioState.ts` is the port of `service/portfolio.build`: rows -> domain values as the
Python store converts them (`investments/rows.ts`, domain ids are the app's `str(pk)` because the
portfolio math breaks ties in Python `str` order of ids; `serialize.ts` maps them to natural keys when
writing), then `buildSnapshot` -> `valuePortfolio` -> `allocate` from `@cashu/domain`. Floats Python
writes as floats are wrapped with `pyFloat()` (`output.ts`). Not produced here: `investments.allocation_view`
(the allocation_drift rule, S15b, and the views, S22a), `investments.positions` / `position_detail` (views,
S22a; their lots and realized trades are the same values `investments.valuation` already checks:
`snapshot.holdings[].lots`, `snapshot.realized`, `valued.realized`).

### Temporary strategy bridge (S14)

The strategy loader is not ported yet, so `src/producers/investments/strategy_bridge.py` exports what
`build` takes from a profile's strategy (base currency, `data` thresholds, allocation plan) to
`<lab>/parity/bridge-strategy/<dataset>/investments.strategy.json`, through golden.py's harness:

```bash
.venv/bin/python packages/parity/src/producers/investments/strategy_bridge.py --dataset lab
```

Delete it (and `strategyBridge.ts`) when the TS strategy loader lands; both carry the S14 transitional marker.

### Temporary bridge for contributors not ported yet

Net worth asks every module's contributor. Until loans and assets (S11) and investments (S13) are
ported, `src/producers/core/networth_bridge.py` exports only those contributors' results (accounts
each values, `latest()` now and at as_of - 365 days), through golden.py's harness (run copy, offline,
frozen clock), to `<lab>/parity/bridge/<dataset>/core.networth_contributors.json`:

```bash
.venv/bin/python packages/parity/src/producers/core/networth_bridge.py --dataset demo
```

Everything core owns (balance snapshots and their source rank, contributor precedence, signs, per
currency totals, breakdown) is recomputed in TS; the cash pool runs through a stand-in of budget's
contributor on the core `RunningValuation` (`core/cashPool.ts`). When a module's TS contributor lands,
drop it from `BRIDGED` / `BRIDGED_MODULES`; delete the bridge with the last one.

**Lab follow-up:** `core.networth` on `lab` is enabled once the TS brokerage contributor (S13) replaces
the bridge for investments (`datasets: ["demo", "lab"]` in `PRODUCERS`). `core.networth_series`
needs `at()` / `axisDates()` of the bridged contributors, so it waits for S11 and S13 too.
