# Parity goldens (Python side)

Deterministic outputs of the Python app, the oracle the TypeScript port is compared against
(`packages/parity`, scope S03). Scope S02 of the TS migration.

```bash
.venv/bin/python parity/python/golden.py --make-demo           # once: the synthetic demo dataset
.venv/bin/python parity/python/golden.py                       # both datasets, every check
.venv/bin/python parity/python/golden.py --dataset demo --check core.networth
.venv/bin/python parity/python/golden.py --dataset demo --update-golden-demo   # refresh parity/golden-demo/
```

## Datasets

| Name | Source | Goldens |
|---|---|---|
| `lab` | `~/cashu-lab/data` (a copy of real data, schema 0025) | `~/cashu-lab/parity/out/lab/`, never in git |
| `demo` | `~/cashu-lab/parity/demo-data`, made by `scripts/demo_data.py --data-dir ... --today 2026-10-01` | `~/cashu-lab/parity/out/demo/`, committed copy in `parity/golden-demo/` |

The demo dataset is generated once and reused: its rows carry the wall-clock creation timestamps of
that generation, so the committed demo goldens belong to that exact dataset. `index.json` records the
dataset's manifest hash (`source`); regenerating the dataset means regenerating the goldens.

## How a run stays safe and deterministic

- The parent process never imports cashU. For each dataset it hashes the source dir (sha256 over every
  file), copies it to a fresh `~/cashu-lab/parity/run-<ts>-<dataset>/data`, runs the checks in a child
  interpreter and hashes the source again: a changed byte fails the run. The copy is deleted afterwards
  (`--keep-run` keeps it).
- The child's environment is set before cashU is imported: `CASHU_DATA_DIR` = the copy, workspaces,
  `HOME`, the pre-rename data dir and launch agents inside the run dir, `CASHU_TESTING=1` (no `.env.dev`,
  no calendar fetch), `CASHU_AUTO_DAILY=0`, `CASHU_PRICE_REFRESH=0`, `CASHU_LANG=pl`, the failing keyring
  backend, `PYTHONHASHSEED=0`, `TZ=Europe/Warsaw`. It asserts `paths.data_dir()` and the engine URL are
  the copy, then runs `init_db()` (which upgrades only the copy).
- Offline (`python/offline.py`): httpx transports, `urlopen` and non-Unix socket connects raise; the
  market / instrument-search sources are the test suite's offline ones. Blocked attempts are counted per
  check (`network_blocked` in the index).
- Frozen clock (`python/frozen.py`): `date.today()` / `datetime.now()` / `utcnow()` return the dataset's
  instant (`lab` 2026-10-31 12:00, `demo` 2026-10-01 12:00, local). `as_of` of every check is that day.
  `time.time()` is not frozen (no check output depends on it).
- MCP payee references (`payee:<hmac>`) are keyed by a per-installation secret; the run copy gets a fixed
  one, `sha256(b"cashu-parity-payee-key-v1")`, which the TS side must use too.

## Canonical JSON (`python/canon.py`)

Sorted keys, compact separators, UTF-8, trailing newline. `Decimal` -> string exactly as Python's
`str()` (`"1E+1"`, `"0.00"`); dates `YYYY-MM-DD`; datetimes `isoformat()` (naive stays naive); floats as
JSON numbers (Python `repr`), NaN / Infinity as strings; enums by value; sets sorted; dataclasses as
objects of their fields; MCP `Labelled` leaves as `{"$label": ..., "value": ...}`; an ORM row as its
natural key; run-specific absolute paths as `$DATA_DIR` / `$RUN_DIR`.

Integer row ids become natural keys `<prefix>:<16 hex of sha256(parts joined by U+001F)>` (`~2`, `~3`
for equal parts, in id order). `SPECS` in `canon.py` lists the parts per table (for example accounts:
profile key, bank, external id, type, currency, name when there is no external id; instruments: ISIN,
symbol, MIC, currency, name). Which table an id belongs to comes from the field name (`FIELD_TABLES`,
plus the `*_instrument_id(s)` style suffixes), for a bare `id` from its parent field (`PARENT_TABLES`),
else from the check's overrides. An id-like integer that no rule places fails the check
(`unmapped id`), so a new id never lands in a golden unnoticed. Hashed keys keep data out of JSON paths.

## Output

`~/cashu-lab/parity/out/<dataset>/<check>.json` and `index.json`:
`{format, dataset, clock, tz, source, commit, dirty, checks: [{check, rows, sha256, network_blocked,
dangling_refs}], skipped: [{check, item, reason}], natural_keys: {table: count}}`. `commit` is the repo
HEAD the run came from, `dirty` whether tracked files differed from it; `pnpm parity` refuses goldens
of another commit (`packages/parity/README.md` "Staleness guard"). The bridges record the same. stdout shows check names, row counts
and hashes only; tracebacks go to `errors.log` next to the outputs.

## Checks

| Check | Source |
|---|---|
| `core.networth`, `core.networth_series` | `core/networth.py` (per currency, breakdown, daily / weekly liquid / monthly components) |
| `budget.dedup`, `budget.ingest_fixtures` | `modules/budget/ingestion/` (v2 content hash and occurrence of stored rows; the bank CSV parsers and dedup on the synthetic fixtures, `checks/budget_ingestion.py`) |
| `budget.analytics` | `modules/budget/analytics.py` (currencies, cashflow, spending by period, drill-down, recurring) |
| `budget.month_close` | `modules/budget/monthclose.py` (default month + last 6, API shape and raw) |
| `loans.valuation` | `modules/loans/service.loan_summary`, `valuation.py`, `amortization.summarize` |
| `assets.depreciation` | `modules/assets/depreciation.py`, the assets manual rows |
| `investments.overview`, `.positions`, `.position_detail`, `.signals`, `.alerts`, `.watchlist`, `.strategy_status`, `.accounts`, `.review_digest` | `modules/investments/service/views.py` |
| `investments.valuation`, `investments.allocation` | `portfolio/valuation.py`, `portfolio/allocation.py` via `service/portfolio.build` (the pure pipeline; TS scope S13) |
| `investments.allocation_view` | `service/views.allocation_view` on the same state (needs the allocation_drift rule; TS scopes S15b + S22a) |
| `investments.performance` | `performance/service.py` (every range + attribution) |
| `investments.rules` | `rules/engine.py` outcomes at `as_of` (pure, nothing persisted) |
| `investments.strategy_loader` | `strategy/loader.py` on each profile's files and the bundled templates |
| `investments.import_plan` | `importing/plan.py`: a dry-run re-import of every archived file (`inv_import_batches`, importer rebuilt from the batch and the account's mapping) against the stored instruments (`DbInstrumentLookup`) and hashes, plus whether the plan's dedup hashes are the batch's stored ones (TS scope S17c) |
| `mcp.tool_schemas` | `core/mcp/registry.py` (schemas, annotations, listing per profile) |
| `mcp.read_strict`, `mcp.read_amounts`, `mcp.read_raw` | every read tool of `core/mcp/server.py`, redacted in both privacy levels and the raw labelled trees |

Not covered (recorded in `skipped`): the MCP read tools that take a file path or run connector code
(`validate_budget_import`, `inspect_export`, `validate_import`, `test_connector`).

## Known intentional differences

- Account / instrument merges (event spec v1.2, R-2): after a merge the TS store resolves each field
  by last writer (HLC) across the merged members, while Python keeps the target's values. A newer
  edit on the source therefore beats an older target value. Checks that cover merged entities must
  normalise this (compare after applying the same rule) instead of failing on it.
- Erste detection (S07, quirk Q4): Python's `ErsteImporter.match_score` split the first line at every
  `,`, so a quoted export without the bank's name was not detected (`detect_importer` -> None). The TS
  port also reads that line as a csv record and detects it. Detection is therefore not part of the
  `budget.ingest_fixtures` golden; `registry.vectors.test.ts` asserts Python's answer for every
  fixture except the listed quoted Erste files. Parsing and hashes are unchanged.
