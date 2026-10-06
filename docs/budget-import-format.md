# cashU budget import format (format_version 1)

The documented file format of the budget module: bank statements (transactions and balances of one bank
account). The built-in banks (mBank, Erste, Pekao) are read from their own CSV exports; any other bank, a
bank API or a hand-written converter produces this format, and cashU imports it natively through the
same preview and deduplication as a bank export. This document is the complete specification.

- Format name: `cashu-budget-import`, version `1`.
- Two equivalent variants: **JSON** (`.json`, required for connectors) and **CSV** (`.csv`, for
  hand-written converters). Both share one strict validator and the same field names.
- One file = one bank account. It holds booked transactions and, optionally, closing balances.
- The importer is strict: every problem is reported with its row and field, and a file with any error
  cannot be imported until it is fixed. Nothing is silently guessed or dropped. Problem messages never
  repeat a value from the file (they name the kind, the row and the field), so they are safe to show to
  an agent.
- JSON Schema of the JSON variant: [`schemas/cashu-budget-import.v1.json`](schemas/cashu-budget-import.v1.json)
  (generated from the validator's models by `scripts/gen_connector_schemas.py`).

The investments module has its own format ([`import-format.md`](import-format.md)); the two are separate.

## 1. Conventions

| Topic | Rule |
| --- | --- |
| Encoding | UTF-8. A leading byte order mark (EF BB BF) is allowed. |
| Dates | `YYYY-MM-DD` (ISO 8601 calendar date, e.g. `2026-10-04`). No other format is accepted. |
| Amounts | `.` as decimal separator, optional leading `-` (or `+`), digits only: `-42.10`, `1234.56`, `10`. No thousands separators, no exponent, no currency symbols. At most 2 decimal places (3 for BHD, IQD, JOD, KWD, LYD, OMR, TND). In JSON a string is preferred; a JSON number is also accepted and read exactly (never as a binary float), also in a connector's output. |
| Sign | `amount` is signed from the account's point of view: **negative = money leaves the account** (card payment, transfer out, fee), positive = money comes in. |
| Currencies | ISO 4217 code, three letters (`PLN`, `EUR`). Upper case is the norm; lower case is accepted and upper-cased. |
| Account numbers | IBAN (`PL61109010140000071219812874`) or the Polish 26-digit NRB. Spaces, dashes and a leading `'` are ignored. 8 to 34 letters and digits after that. |
| Text | Trimmed of surrounding spaces. An empty string means "no value". |
| Empty value | CSV: an empty cell. JSON: `null` or the key left out. |
| Unknown keys / columns | Refused (with a "did you mean" hint). The format is strict on purpose. A CSV whose first line has none of the required columns (`format_version`, `booking_date`, `amount`, `currency`) is refused with one "no header line" problem; an unknown column that looks like data (a name, a title, a number) is reported by position (`column 3`), never by its text. |

## 2. File layout

### 2.1 JSON variant

```json
{
  "format": "cashu-budget-import",
  "format_version": 1,
  "source": "examplebank_api",
  "account": {"iban": "PL99 1090 0000 0000 0000 0000 0001", "name": "Konto osobiste", "currency": "PLN",
              "institution": "examplebank"},
  "balances": [{"date": "2026-10-05", "amount": "1234.56"}],
  "transactions": [ {"booking_date": "2026-10-04", "amount": "-42.10", "currency": "PLN", "...": "..."} ]
}
```

| Key | Required | Rule |
| --- | --- | --- |
| `format` | yes | exactly `"cashu-budget-import"` (the deprecated `"finanse-budget-import"`, legacy name, is still accepted) |
| `format_version` | yes | the number `1` |
| `source` | no | who produced the file: `^[a-z][a-z0-9_]{0,31}$` (`examplebank_api`, `my_converter`) |
| `account` | yes | object, section 3.1 |
| `balances` | no | array of `{date, amount}`: the account's closing balance on that date (section 3.3) |
| `transactions` | yes | array of transaction objects (section 3.2); may be empty when `balances` has entries |

### 2.2 CSV variant

A header line, then one row per transaction. Comma separated, `"` quotes (standard RFC 4180 quoting).

- Required columns: `format_version`, `booking_date`, `amount`, `currency`.
- Optional columns: every other transaction field of section 3.2.
- File-level values are constant columns, the same value in every row: `account_iban`,
  `account_currency`, `account_name`, `account_institution`, `source` (a different value in a later row
  is an error). `account_currency` may be left out when every row has the same `currency`.
- `format_version` is `1` in every row.
- Balances are not supported in CSV (use `balance_after`, or the JSON variant).
- Blank lines are skipped. Row numbers in problem reports count the lines after the header (blank ones
  included), starting at 1.

## 3. Fields

### 3.1 Account

| Field | Required | Meaning |
| --- | --- | --- |
| `currency` | yes | currency of the account (CSV: `account_currency`). Importing into an existing account (chosen in the preview, found by `iban` or by `name`) of another currency is refused (`import_currency_mismatch`): amounts and balances would be stored in the wrong currency. |
| `iban` | no | the account's number. cashU looks it up among **all** accounts of the profile (whatever bank); when found the statement goes there, otherwise a new account is created. Without it the owner chooses the account in the preview, or a new account named after `name` is created (and found again by that name on the next import). |
| `name` | no | name of a newly created account, max 120 characters (never renames an existing one) |
| `institution` | no | institution id of a newly created account (`mbank`, `pekao`, `erste`, `millennium`, or your own lower-case id; an unknown id is a warning and is kept as is). Default: `source`. |

### 3.2 Transaction

| Field | Required | Meaning |
| --- | --- | --- |
| `booking_date` | yes | date the bank booked it |
| `amount` | yes | signed amount (section 1) |
| `currency` | yes | currency of `amount` (a currency other than the document's `account.currency` is a warning) |
| `value_date` | no | value date |
| `counterparty_name` | no | the other party (shop, person, employer), max 500 characters |
| `counterparty_iban` | no | the other party's account number: internal transfers between the owner's own accounts are matched **only** by this field |
| `description` | no | the bank's operation type or description, max 500 characters |
| `reference` | no | transfer title / card payment text, max 200 characters. Categorization reads `reference`, `description` and `counterparty_name`. |
| `transaction_id` | no | the bank's own stable id of this transaction, max 200 characters (section 4) |
| `balance_after` | no | the account balance right after this transaction (the last one of a day becomes that day's closing balance) |

### 3.3 Balances

`{"date": "2026-10-05", "amount": "1234.56"}`: the account balance at the end of that day, in the
account currency. An explicit balance wins over a `balance_after` of the same date. Net worth uses the
newest balance; send at least today's (or the statement's last day's) balance when you know it.

## 4. Duplicate detection

Importing the same or an overlapping file again never creates duplicates:

- A row whose `transaction_id` is already stored for the account is a duplicate.
- Otherwise the content key decides: (account, `booking_date`, `amount`, `currency`, counterparty account
  number or else the normalized `counterparty_name`, the normalized `description` + `reference`). Rows of
  the file first "consume" equal rows already stored; only the surplus is new, so two identical payments
  on one day stay two.
- Within one file, two rows with the same `transaction_id` are an error.

The same period from another source (the bank's CSV export, Open Banking) describes the same transactions
with other texts, so the content key cannot match them. A document in this format (a file or a connector)
therefore goes through the same rule as the Open Banking sync, the **newest-day rule**: what is already
stored for the account is authoritative up to the account's newest stored day.

- A row that neither its `transaction_id` nor the content key matched is **overlap** (not imported) when
  its `booking_date` is before the account's newest stored day.
- On the newest stored day itself it first takes the place of a stored row of the same amount that no row
  of the file matched (its twin from the other source); only the surplus is new.
- Rows after that day are new.
- The preview counts overlap rows (`overlap`) among the duplicates and warns about them
  (`import.overlap`); a connector sync with overlap rows always waits for the owner's approval.

So import history oldest first: an older period imported after a newer one into the same account is
overlap. An account with no stored transactions takes every row.

Rules for converter authors:

- Use `transaction_id` only for an id the bank itself assigns and that never changes between exports.
  **Never invent one** from row numbers or counters: leave it empty instead.
- Keep the conversion deterministic: the same input must always produce the same rows (the content key
  then recognises a re-import of your own output).

## 5. Full example

### 5.1 JSON

```json
{
  "format": "cashu-budget-import",
  "format_version": 1,
  "source": "examplebank_api",
  "account": {
    "iban": "PL99 1090 0000 0000 0000 0000 0001",
    "name": "Konto osobiste",
    "currency": "PLN",
    "institution": "examplebank"
  },
  "balances": [{"date": "2026-10-05", "amount": "5120.40"}],
  "transactions": [
    {"booking_date": "2026-10-01", "value_date": "2026-10-01", "amount": "9000.00", "currency": "PLN",
     "counterparty_name": "PRACODAWCA TEST SP. Z O.O.", "counterparty_iban": "PL99102000000000000000000777",
     "description": "PRZELEW PRZYCHODZACY", "reference": "WYNAGRODZENIE 09/2026",
     "transaction_id": "TX-0001", "balance_after": "9500.00"},
    {"booking_date": "2026-10-03", "amount": "-139.00", "currency": "PLN",
     "counterparty_name": "KLUB SPORTOWY TEST", "description": "ZAKUP PRZY UZYCIU KARTY",
     "reference": "KLUB SPORTOWY TEST WARSZAWA", "transaction_id": "TX-0002"},
    {"booking_date": "2026-10-04", "amount": "-3000.00", "currency": "PLN",
     "counterparty_name": "BANK HIPOTECZNY TEST", "counterparty_iban": "99160000000000000000000555",
     "description": "PRZELEW WYCHODZACY", "reference": "RATA KREDYTU HIPOTECZNEGO",
     "transaction_id": "TX-0003"},
    {"booking_date": "2026-10-05", "amount": "-9.99", "currency": "EUR",
     "counterparty_name": "SERWIS TEST", "description": "ZAKUP PRZY UZYCIU KARTY",
     "reference": "SERWIS TEST 9.99 EUR", "transaction_id": "TX-0004"}
  ]
}
```

### 5.2 CSV

```csv
format_version,booking_date,amount,currency,counterparty_name,counterparty_iban,description,reference,transaction_id,account_iban,account_currency,source
1,2026-10-01,9000.00,PLN,PRACODAWCA TEST SP. Z O.O.,PL99102000000000000000000777,PRZELEW PRZYCHODZACY,WYNAGRODZENIE 09/2026,TX-0001,PL99109000000000000000000001,PLN,my_converter
1,2026-10-03,-139.00,PLN,KLUB SPORTOWY TEST,,ZAKUP PRZY UZYCIU KARTY,"KLUB SPORTOWY TEST, WARSZAWA",TX-0002,PL99109000000000000000000001,PLN,my_converter
1,2026-10-04,-3000.00,PLN,BANK HIPOTECZNY TEST,99160000000000000000000555,PRZELEW WYCHODZACY,RATA KREDYTU HIPOTECZNEGO,TX-0003,PL99109000000000000000000001,PLN,my_converter
```

## 6. Importing a file

- In the app: Wydatki › `Import` (or the first steps' `Importuj wyciąg`), `Bank`: `rozpoznaj
  automatycznie` recognises the format (a JSON object naming `cashu-budget-import`, or a CSV whose
  header has `format_version` and `booking_date`); or choose `Format cashU` explicitly. The preview
  shows new rows and duplicates before anything is written.
- HTTP: `POST /api/p/<profile>/budget/import/preview` (multipart `file`, `bank=cashu-budget`), then
  `POST /api/p/<profile>/budget/import/commit` with the returned `file_id`.
- A connector ([`connectors.md`](connectors.md)) returns the JSON variant as its `document`; it goes through the same
  validation and preview, its rows are marked as coming from a connector.

## 7. Validating a file

Validation needs no database and changes nothing:

```python
from pathlib import Path
from cashu.modules.budget.ingestion.canonical import validate_budget_document

data = Path("converted.json").read_bytes()
report = validate_budget_document(data, "converted.json")   # or a .csv
print(report.summary())    # counts, then every error and warning with row and field
assert report.ok           # True when the file can be imported
```

`report.issues` lists every problem; `blocking` ones refuse the import, the others are warnings. Each
has `kind`, `row` (1-based transaction number, `None` for file-level problems), `field` and a value-free
`message`. Kinds: `file_format`, `missing_column`, `unknown_field`, `missing_value`, `invalid_value`,
`inconsistent_file`, `duplicate_id` (errors); `currency_mismatch`, `unknown_institution`, `empty`
(warnings). `report.as_dict()` is the same as JSON. `cashu connectors test` prints this report for a
budget connector's output.

Checklist for converter authors:

1. `format` and `format_version` (JSON) / a `format_version` column of `1` (CSV).
2. Dates `YYYY-MM-DD`, amounts with `.` and no thousands separators, at most 2 decimals.
3. Outflows negative, inflows positive.
4. `counterparty_iban` filled whenever the bank shows it (internal transfers depend on it).
5. `transaction_id` is the bank's stable id or empty, never a row number.
6. Run `validate_budget_document` and fix every error; read every warning.

## 8. Versioning

This is `format_version` 1. Files without a version or with another version are refused. Any change to
field meanings, required fields or accepted values will come as a new version; the importer will keep
reading version 1 files.

Before the rename to cashU (legacy name) this format was called `finanse-budget-import` and its
importer id `finanse-budget`. Both are still accepted and read as `cashu-budget-import` /
`cashu-budget`; they are deprecated, so write the new ids in new converters and connectors.
