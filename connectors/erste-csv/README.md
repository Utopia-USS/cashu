# erste-csv

Converts an **Erste Bank Polska** (formerly **Santander Bank Polska**) CSV export of the account history
into `cashu-budget-import` v1 JSON. A TypeScript (Deno) port of the parser cashU has built in
(`src/cashu/modules/budget/ingestion/csv_import/erste.py`): every row gets the same date, amount,
counterparty and texts, so a file imported earlier with the built-in parser is recognised as a
duplicate, and the account is found again by its number (institution `erste`; the account numbers did
not change with the rebrand, so legacy Santander history lands in the same account).

- Kind `file`, module `budget`, extension `csv`. No network, no dependencies.
- `connector.ts` speaks the protocol, `parse.ts` is the Erste part, `pycompat.ts` the Python-compatible
  CSV / encoding / number / date primitives (identical in `mbank-csv` and `pekao-csv`).

## Which export

The account history as CSV from Erste's web banking (and the same export from Santander's web banking
before the rebrand): in the account's history choose the period and export it as CSV. The menu wording
changes from time to time; the file has no header row and its first line carries the account number
with a leading apostrophe.

What is read:

- UTF-8 with a byte order mark (Windows-1250 legacy exports also work), `,` separated, quoted fields.
- The first row, when its third cell is an apostrophe-guarded account number: the account number, the
  currency (fifth cell) and the current balance (seventh cell) on the export date (first cell).
- Every other row: booking date, value date (`DD-MM-YYYY`), title, counterparty, counterparty account,
  amount, balance after the operation, then a type code and an optional empty trailing cell.
- Without that first row the account number is the first 26-digit number anywhere in the file (as
  the built-in parser does): check the account in the import preview.

## Limits

- No `transaction_id`: the export has no stable id. Duplicates are recognised by content (and, for a
  file that overlaps what is already stored, by the import's newest-day rule).
- The summary balance is sent as a closing balance only where the built-in import let it win (rows
  newest first, or no row of the export date with a balance); otherwise that day's last row balance
  stands, as before.
- A title longer than 200 characters is cut to 200 (the format's limit for `reference`); a
  counterparty account number that is not 8 to 34 letters and digits is left out.
- `detect` answers yes for a file with the summary row shape or an Erste / Santander / BZ WBK name
  that really converts.

## Test

    cashu connectors test connectors/erste-csv --file connectors/erste-csv/fixtures/erste-historia.csv

The fixtures are synthetic (made-up names, `99` account numbers, invented amounts).
