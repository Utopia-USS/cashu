# Converter route and converter contract (one-off scripts)

What this is: the one-off alternative to a connector, for when the user prefers a script, and the
contract every converter script follows (connectors follow `references/connectors.md` instead).

## Converter route (one-off)

For the investments module, when the user prefers a script to a connector:

- Write `scripts/import_<source>.py` from `references/converter_template.py` (contract below), test it on
  synthetic data with `cashu invest validate <synthetic output>`.
- Run it yourself with the system Python in isolated mode (not the cashU app binary, not a venv):
  `python3 -I scripts/import_<source>.py inbox/<export> inbox/converted/<source>-<YYYY-MM-DD>.csv`
  (create `inbox/converted` first); tell the user in one line what the command does. Exit 1 = a data
  problem with a value-free message: fix, test on synthetic data, rerun.
- `validate_import(<output.csv>)`, fix by kind and row; then `propose_import(<output.csv>, account)`. The
  owner checks the preview and the reconciliation in Inwestycje > Import and commits. Re-importing an
  overlapping export does not duplicate rows (`references/import-format.md` section 5). Delete the
  converted file after the commit.
- Budget statements: a script may write a `cashu-budget-import` file (CSV or JSON) to `inbox/converted/`;
  check it with `validate_budget_import(<output>)` and fix by kind and row; the owner imports it in
  Wydatki > Import (`Format cashU`). Import older periods first: rows between the account's oldest and
  newest stored day are skipped as overlap, rows before the oldest are a backfill and get imported
  (`references/budget-import-format.md` section 4). A connector is the
  better choice here.

## Converter contract (scripts) - connectors follow `references/connectors.md`

- Python standard library only (`csv`, `zipfile` + `xml.etree` for xlsx, `json`, `decimal`,
  `datetime`). No network, no subprocesses, no environment variables, never imports `cashu`, reads
  only the export and writes only the output file.
- Invocation: `python3 -I import_<source>.py <export file> <output .csv>`; exit 0 on success, 1 with a
  message on stderr on a data problem, 2 on wrong usage. Nothing on stdout.
- Error messages name the row and the field, never the cell value.
- Deterministic: the same export always gives the same rows, oldest first, `time` filled when known.
- `external_ref` only from a stable broker id, never from row numbers or counters. Leave
  `account_hint` empty (the account is chosen in `propose_import`).
- Numbers as exact decimal text (`decimal.Decimal`, never float). `cash_amount` exactly as the broker
  booked it, with its sign; `quantity`, `price`, `fee`, `tax` never negative.
- A trade settled in another currency: `cash_currency` plus `cash_amount` or `fx_rate`.
- Unknown type labels, unparsable dates or numbers: an error, never a silent skip or a guess.
- A header docstring: broker, export kind, profile, date, input description, run command.
- The full field reference and checklist: `references/import-format.md` (sections 3-9 and 11).
