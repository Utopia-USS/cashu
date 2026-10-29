# pekao-csv

Converts a **Bank Pekao** CSV export of the account history into `cashu-budget-import` v1 JSON. A
TypeScript (Deno) port of the parser cashU has built in
(`src/cashu/modules/budget/ingestion/csv_import/pekao.py`): every row gets the same date, amount,
counterparty and texts, so a file imported earlier with the built-in parser is recognised as a
duplicate, and the account is found again by its number (institution `pekao`).

- Kind `file`, module `budget`, extension `csv`. No network, no dependencies.
- `connector.ts` speaks the protocol, `parse.ts` is the Pekao part, `pycompat.ts` the Python-compatible
  CSV / encoding / number / date primitives (identical in `mbank-csv` and `erste-csv`).

## Which export

The operation history as CSV from Pekao24: in the account's history choose the period and download it
as CSV. The menu wording changes from time to time; the file has a header row with `Rachunek
źródłowy` and `Rachunek docelowy`.

What is read:

- UTF-8 (Windows-1250 also works), `;` separated, a header row with `Data księgowania`, `Data waluty`,
  `Nadawca / Odbiorca`, `Rachunek źródłowy`, `Rachunek docelowy`, `Tytułem`, `Kwota operacji`,
  `Waluta` (`Numer referencyjny`, `Typ operacji`, `Kategoria` are not used).
- The own account: the account number seen most often in the source and destination columns; the
  counterparty account is the other side of each row.
- Signed Polish amounts (`-1 234,56`), dates `DD.MM.YYYY` or `YYYY-MM-DD`, each row's currency.

## Limits

- No balances: the export has no running balance.
- No `transaction_id`: `Numer referencyjny` is not used, as in the built-in parser (rows imported
  before carry no id, so an id would not help against them).
- Rows without a date or an amount are dropped without a count.
- A title longer than 200 characters is cut to 200 (the format's limit for `reference`); an account
  number that is not 8 to 34 letters and digits is left out.
- `detect` answers yes only for a file with Pekao's column names that really converts.

## Test

    cashu connectors test connectors/pekao-csv --file connectors/pekao-csv/fixtures/pekao-historia.csv

The fixtures are synthetic (made-up names, `99` account numbers, invented amounts).
