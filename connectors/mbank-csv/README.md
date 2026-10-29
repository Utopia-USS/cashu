# mbank-csv

Converts an **mBank** CSV export of the account history into `cashu-budget-import` v1 JSON. A
TypeScript (Deno) port of the parser cashU has built in
(`src/cashu/modules/budget/ingestion/csv_import/mbank.py`): every row gets the same date, amount,
counterparty and texts, so a file imported earlier with the built-in parser is recognised as a
duplicate, and the account is found again by its number (institution `mbank`).

- Kind `file`, module `budget`, extension `csv`. No network, no dependencies.
- `connector.ts` speaks the protocol, `parse.ts` is the mBank part, `pycompat.ts` the Python-compatible
  CSV / encoding / number / date primitives (identical in `erste-csv` and `pekao-csv`).

## Which export

The account history as CSV from mBank's web banking (personal accounts, eKonto, eKonto walutowe in
EUR, USD, NOK, HUF ...): in the transaction history choose the period and download it as CSV (the
"elektroniczne zestawienie operacji" / "lista operacji" file). The menu wording changes from time to
time; the file is the one that starts with `mBank S.A.` and has a `#Data operacji` column.

What is read:

- Windows-1250 text, `;` separated, quoted fields.
- The preamble: the account number after `#Numer rachunku` and the account currency after `#Waluta`.
- The table after the header row with `#Data księgowania` / `#Data operacji`, `#Opis operacji`,
  `#Tytuł`, `#Nadawca/Odbiorca`, `#Numer konta`, `#Kwota`, `#Saldo po operacji` (a `#Waluta` column,
  when present, gives each row's currency).
- Polish amounts (`-1 234,56`), dates `YYYY-MM-DD` or `DD.MM.YYYY`, the running balance as
  `balance_after` (the import keeps the last one of a day).

## Limits

- No `transaction_id`: the export has no stable id. Duplicates are recognised by content (and, for a
  file that overlaps what is already stored, by the import's newest-day rule).
- Rows without a date or an amount (preamble, footer, totals) are dropped without a count.
- A title longer than 200 characters is cut to 200 (the format's limit for `reference`); a
  counterparty account number that is not 8 to 34 letters and digits is left out.
- `detect` answers yes only for a file with an mBank signature (`mBank S.A.`, `#Data operacji`,
  `Elektroniczne zestawienie operacji`) that really converts.

## Test

    cashu connectors test connectors/mbank-csv --file connectors/mbank-csv/fixtures/mbank-zestawienie.csv

The fixtures are synthetic (made-up names, `99` account numbers, invented amounts).
