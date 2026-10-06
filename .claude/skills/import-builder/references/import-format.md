<!-- Copy shipped with this skill, generated from the cashU sources; do not edit it here. -->

# cashU import format (format_version 1)

The canonical file format of the investments module. Any broker export can be converted into it with a
small custom parser (written by hand or with an LLM); cashU then imports it natively. This document is
the complete specification: a parser that follows it produces files that import without guesswork.

- Format name: `cashu-import`, version `1`.
- Two equivalent variants: **CSV** (`.csv`) and **JSON** (`.json`). Both carry the same records with the
  same field names and the same rules.
- One file = one broker account. It may hold transactions, a position snapshot and corporate actions.
- The importer is strict: every problem is reported with its row and field, and a file with any error
  cannot be imported until it is fixed. Nothing is silently guessed or dropped.

Other ways in: CSV exports can also be imported without code through a YAML column mapping (the generic
CSV importer, see `generic_csv_example.yaml`). This document is
only about the canonical format.

## 1. Conventions

| Topic | Rule |
| --- | --- |
| Encoding | UTF-8. A leading byte order mark (EF BB BF) is allowed. |
| Dates | `YYYY-MM-DD` (ISO 8601 calendar date, e.g. `2026-01-07`). No other format is accepted. |
| Times | `HH:MM` or `HH:MM:SS`, 24-hour clock (e.g. `09:05`, `15:30:12`). No zone, no fractions. |
| Decimal numbers | `.` as decimal separator, optional leading `-`, digits only: `1234.5`, `-0.75`, `10`. No thousands separators, no `+`, no exponent (`1e3`), no currency symbols, no percent signs. Any number of decimal places; values are exact decimals. In JSON a number may also be written as a JSON number (`12.5`); it is read exactly (never as a binary float), also in a connector's output. |
| Currencies | ISO 4217 code, three upper-case letters (`PLN`, `USD`, `EUR`). |
| Text | Trimmed of surrounding spaces. An empty string means "no value". |
| Booleans | `true` / `false` (CSV: case-insensitive text, empty = `false`; JSON: `true` / `false`). |
| Empty value | CSV: an empty cell. JSON: `null` or the key left out. |

## 2. File layout

### 2.1 CSV variant

- Comma `,` as delimiter, double quote `"` as quote character (RFC 4180: a field containing `,`, `"` or a
  line break is quoted; a `"` inside a quoted field is written `""`). Line endings LF or CRLF.
- The first line is the header with column names from section 3, in any order. Unknown column names and
  duplicated columns are errors. Only `format_version`, `record` and `date` are required columns; a
  missing optional column means "empty in every row".
- Every following non-blank line is one record. Every record must have `format_version` = `1`.
- File-level values `source` and `account_hint` are optional columns; when used they must hold the same
  value in every row where they are not empty.
- Row numbers in error messages: `row 0` is the first record after the header.

### 2.2 JSON variant

A single JSON object:

```json
{
  "format": "cashu-import",
  "format_version": 1,
  "source": "examplebroker",
  "account_hint": "Brokerage account 1",
  "records": [ { "record": "txn", "date": "2026-01-05", "...": "..." } ]
}
```

| Key | Required | Meaning |
| --- | --- | --- |
| `format` | yes | Always `"cashu-import"`. The pre-rename id `"finanse-import"` (legacy name) is still accepted and deprecated. |
| `format_version` | yes | Always `1` (number). |
| `source` | no | See section 3.1. |
| `account_hint` | no | See section 3.1. |
| `records` | yes | Array of record objects; keys are the field names of section 3 (except `format_version`, `source` and `account_hint`, which live only at the top level). Unknown keys are errors. |

Row numbers in error messages: `row 0` is `records[0]`.

## 3. Fields

### 3.1 File-level fields

| Field | Format | Meaning |
| --- | --- | --- |
| `format_version` | `1` | Version of this specification. CSV: a column, `1` in every row. JSON: top-level number. |
| `source` | `[a-z][a-z0-9_]*`, max 32 characters | Id of the broker the data came from (e.g. `examplebroker`). Symbols of the file are remembered under this name, so the same ticker from two brokers never gets mixed up. Use the same value for every file from that broker. Default: `cashu` (the deprecated `finanse`, legacy name, means the same and its symbols still match). |
| `account_hint` | text, max 200 characters | Account number or name from the export; only used to suggest the target account. |

### 3.2 Record fields

`record` selects the kind of record. Each kind accepts only the fields marked for it; a value in a field
that does not belong to the record kind is an error (it usually means a shifted column).

Legend: **R** required, **o** optional, **-** must be empty.

| Field | Type | txn | position | rename | delisting | Meaning |
| --- | --- | --- | --- | --- | --- | --- |
| `record` | `txn` / `position` / `rename` / `delisting` | R | R | R | R | Record kind. |
| `date` | date | R | R | R | R | txn: trade date. position: the date the positions are valid for (end of day). rename / delisting: effective date. |
| `time` | time | o | - | - | - | Time of day of the trade. Only orders rows of the same date (section 6). |
| `settle_date` | date | o | - | - | - | Settlement date. |
| `type` | transaction type | R | - | - | - | See section 4. |
| `external_ref` | text, max 200 | o | - | - | - | The broker's own id of the row or order (section 5). |
| `symbol` | text | o | o | R | R | Ticker as listed on `exchange` (`PKN`, `AAPL`, `VWCE`). rename: the old ticker. |
| `isin` | ISIN | o | o | o | o | 12 characters: 2 letters, 9 letters/digits, 1 check digit (`IE00B4L5Y983`). rename: the old ISIN. Upper-case. |
| `name` | text | o | o | - | - | Instrument name (`iShares Core MSCI World UCITS ETF`). |
| `exchange` | MIC or hint | o | o | o | o | Market of the listing, preferably the ISO 10383 MIC (section 7). rename: the old listing. |
| `quantity` | decimal >= 0 | see 4 | R | - | - | Number of units (shares, fund units, coins). Never negative: the direction comes from `type`. |
| `price` | decimal >= 0 | o | - | - | - | Price per unit in `currency`. |
| `currency` | currency | R | R | - | - | Currency of `price`, `gross_amount`, `fee`, `tax` (txn) or of `avg_price`, `market_value` (position). For trades: the currency the instrument is quoted in. |
| `gross_amount` | decimal >= 0 | o | - | - | - | Value before fees and taxes (for trades: quantity * price). |
| `fee` | decimal >= 0 | o | - | - | - | Commission / fees in `currency`. Default 0. |
| `tax` | decimal >= 0 | o | - | - | - | Taxes in `currency` (e.g. dividend withholding tax). Default 0. |
| `cash_amount` | decimal, signed | o | - | - | - | Net effect on the account's cash in `cash_currency`: negative = money left the account, positive = money came in. |
| `cash_currency` | currency | o | - | - | - | Currency the cash moved in. Default: `currency`. |
| `fx_rate` | decimal > 0 | o | - | - | - | Units of `cash_currency` per 1 unit of `currency` (USD trade settled in PLN at 4.0 -> `4.0`). |
| `split_ratio` | decimal > 0 | split: R | - | - | - | New units per old unit: a 1:4 split is `4`, a 10:1 reverse split is `0.1`. |
| `avg_price` | decimal >= 0 | - | o | - | - | Broker's average purchase price per unit, in `currency`. |
| `market_value` | decimal >= 0 | - | o | - | - | Broker's market value of the position, in `currency`. |
| `new_symbol` | text | - | - | R | - | The new ticker. |
| `new_isin` | ISIN | - | - | o | - | The new ISIN. |
| `new_exchange` | MIC or hint | - | - | o | - | The new listing when the market changed. |
| `new_name` | text | - | - | o | - | The new instrument name. |
| `frozen` | boolean | - | - | - | o | `true` = the holding cannot be sold or priced any more (e.g. sanctioned securities); `false` = an ordinary delisting. Default `false`. |
| `note` | text, max 1000 | o | o | o | o | Free text (the broker's description). |

An instrument is identified by `isin` (strongest), then `symbol` (under `source`), then `symbol` +
`exchange`, then `name`. Give the ISIN whenever the export has it; give `exchange` whenever you know it.

## 4. Transaction types and sign conventions

`quantity`, `price`, `gross_amount`, `fee` and `tax` are never negative. Only `cash_amount` carries a sign.

| `type` | Instrument (symbol / isin / name) | `quantity` | `cash_amount` sign | Meaning |
| --- | --- | --- | --- | --- |
| `buy` | R | R, > 0 | <= 0 (error otherwise) | Purchase. Cost basis = gross + fee + tax. |
| `sell` | R | R, > 0 | >= 0 (error otherwise) | Sale. Proceeds = gross - fee - tax. |
| `dividend` | o (recommended) | o (informational) | >= 0 (warning otherwise) | Cash dividend. `gross_amount` = dividend before withholding, `tax` = withholding tax. |
| `interest` | o | - | >= 0 (warning otherwise) | Interest paid to the account (also bond coupons). |
| `deposit` | - | - | >= 0 (error otherwise) | Money paid into the account. |
| `withdrawal` | - | - | <= 0 (error otherwise) | Money taken out of the account. |
| `fee` | o | - | <= 0 (warning otherwise) | A standalone fee (account fee, custody fee). A trade's commission belongs in the trade's `fee` field instead. |
| `tax` | o | - | <= 0 (warning otherwise) | A standalone tax payment. A refund may be positive (warning). |
| `fx_conversion` | - | - | any, R | One leg of a currency exchange (section 4.2). |
| `split` | R | o (informational) | empty or 0 (warning otherwise) | Stock split; requires `split_ratio`. Cash in lieu of fractions is a separate `sell` row. |
| `transfer_in` | R | R, > 0 | empty or 0 (warning otherwise) | Units moved in from elsewhere. `price` = known cost per unit; empty `price` = unknown cost. |
| `transfer_out` | R | R, > 0 | empty or 0 (warning otherwise) | Units moved out (consumes the oldest units first, no profit or loss). |
| `adjustment` | R | R, > 0 | empty or 0 (warning otherwise) | Adds units to match the broker (opens units at `price`; empty = unknown cost). Never use it to reduce units: use `transfer_out`. |

Instrument "-" means: `symbol`, `isin`, `name` and `exchange` must be empty. Quantity "-" means: must be
empty.

### 4.1 Amounts: what to fill in, what is derived

Fill in what the export has; the rest is derived:

1. `gross_amount`: if empty, `quantity * price`; if that is not possible, it is derived from
   `cash_amount` (fee and tax are added back for inflows, removed for outflows; converted with `fx_rate`
   when `cash_currency` differs); if there is no cash amount either, 0 for rows with only a fee or tax and
   for `split`, `transfer_in`, `transfer_out`, `adjustment`. Otherwise the row is an error.
2. `cash_amount`: if empty, derived from the gross amount: inflows (`sell`, `dividend`, `interest`,
   `deposit`) = `gross - fee - tax`, outflows (`buy`, `withdrawal`, `fee`, `tax`) =
   `-(gross + fee + tax)`, `split` / `transfer_*` / `adjustment` = 0. When `cash_currency` differs from
   `currency` the result is multiplied by `fx_rate`; **without `fx_rate` this is an error** (the trade
   amount is never booked as if it were in the cash currency). `fx_conversion` rows always need
   `cash_amount`.
3. When both `gross_amount` and `cash_amount` are given in the same currency, the importer checks that
   they agree with fee and tax (within 0.01) and warns if they do not. Prefer exact broker values: a
   wrong sign or a missing fee is the most common converter bug.

Best practice: always write `cash_amount` exactly as the broker booked it, plus `quantity`, `price`, `fee`
and `tax` for trades.

### 4.2 Currency exchange

A currency exchange is two `fx_conversion` rows on the same date, one per currency, each with its own
`currency` = `cash_currency` and signed `cash_amount`:

```csv
format_version,record,date,time,type,currency,cash_amount,note
1,txn,2026-02-02,10:00,fx_conversion,PLN,-4000.00,PLN to USD
1,txn,2026-02-02,10:00,fx_conversion,USD,1000.00,PLN to USD
```

A trade in one currency settled in another (USD stock paid from a PLN cash account) is one row with
`currency` = `USD`, `cash_currency` = `PLN`, `cash_amount` in PLN and `fx_rate` = PLN per USD.

## 5. external_ref and duplicate detection

Every imported row gets a duplicate-detection key, so importing the same or an overlapping file again
never creates duplicates.

- With `external_ref`: the key is (account, `source`, `external_ref`, `type`, instrument, `quantity`,
  `price`, `currency`) plus an occurrence counter for identical rows. Several rows may share one
  `external_ref` (partial fills of one order, an order and its separate fee row, both legs of a currency
  exchange); they stay apart by type, quantity, price and currency, independently of their order in the
  file. Amounts and dates are not part of the key, so a
  re-export that rounds cash differently still matches.
- Without `external_ref`: the key is (account, `date`, `type`, instrument, `quantity`, `price`,
  `gross_amount`, `cash_amount`) plus an occurrence counter: two identical rows in one file both import,
  and importing the file again recognizes both. Numbers compare by value (`10.50` equals `10.5`).

Rules for converter authors:

- Use `external_ref` only for an id the broker itself assigns and that never changes between exports
  (transaction id, order id, execution id).
- **Never invent `external_ref`** from row numbers, file positions or counters: they shift between
  exports and would turn every re-import into duplicates (or hide real rows). Leave it empty instead.
- Do not reuse one `external_ref` for unrelated events.
- Keep the conversion deterministic: the same export must always produce the same rows.

## 6. Order of rows

Rows may be in any order. The portfolio is computed in chronological order: by `date`; rows of the same
date by `time` when every row of that date has one; otherwise in file order. A file whose first row is
later than its last row (by date, or by time on the same date) is treated as newest-first and same-day
rows are reversed. Recommendation: write rows oldest first and fill `time` whenever the export has it
(a sell before the buy of the same day would otherwise look like selling units you do not hold).

## 7. Exchanges

`exchange` is preferably the ISO 10383 MIC. Recognized MICs: `XNAS`, `XNYS`, `ARCX`, `BATS`, `XASE`,
`IEXG` (US),
`XWAR` (GPW Warsaw), `XNCO` (NewConnect), `XLON`, `XASX`, `XTSE`, `XTSX`, `XHKG`, `XPAR`, `XAMS`, `XBRU`,
`XETR`, `XMIL`, `XMAD`, `XSWX`, `XSTO`, `XCSE`, `XOSL`, `XHEL`. Use `crypto` for crypto assets
(`symbol` = the coin, e.g. `BTC`). Common broker spellings are understood too (`GPW`, `NASDAQ`, `NYSE`,
`XETRA`, `LSE`, `US`); an unknown value is kept as text and only lowers the quality of automatic market
data matching. A symbol suffix such as `PKN.PL` or `VWCE.DE` and the form `TICKER:MIC` (`NVDA:XNAS`,
case-insensitive) are understood, but prefer `symbol` = `PKN` with `exchange` = `XWAR`. Hong Kong tickers
may be written with or without leading zeros (`700`, `0700`).

## 8. Position snapshots

`position` records list what the broker reports as held on `date` (used to reconcile the transaction
history with the broker). Rules:

- One record per instrument; all position records of a file should share one `date`.
- List every holding of the account on that date (a missing instrument is reported as "held in history
  but not at the broker").
- `quantity` is the total number of units (0 is allowed for a closed position the broker still lists).
- A file may contain only positions, only transactions, or both.

## 9. Corporate actions

- **Split**: a `txn` record with `type` = `split`, the instrument and `split_ratio`.
- **Rename** (ticker change, merger into a successor where units carry over 1:1): a `rename` record with
  the old `symbol` (and old `isin` / `exchange` when known), `new_symbol` (and `new_isin`,
  `new_exchange`, `new_name` when known) and the effective `date`. Holdings and their cost carry over; it
  is not a sale plus a purchase. A merger with a ratio is a rename plus a `split` on the same date.
- **Delisting**: a `delisting` record with `symbol` (and `isin` / `exchange`), the `date`, and `frozen` =
  `true` when the holding can no longer be sold or priced (it is then valued manually, 0 by default), or
  `false` for an ordinary delisting (record the final cash-out as a normal `sell`).
- Cash from corporate actions (spin-off cash, tender offers) is a normal `sell` or `dividend` row.

## 10. Full example

The same data in both variants: a deposit, a PLN buy, a EUR buy and a USD buy settled from PLN cash, a
sale filled in two parts of one order, a dividend with withholding tax, an account fee, a currency
exchange, a split, a rename, a frozen delisting and a position snapshot. Both files validate without
errors or warnings.

### 10.1 CSV

```csv
format_version,record,date,time,settle_date,type,external_ref,symbol,isin,name,exchange,quantity,price,currency,gross_amount,fee,tax,cash_amount,cash_currency,fx_rate,split_ratio,avg_price,market_value,new_symbol,new_isin,new_exchange,new_name,frozen,note,source,account_hint
1,txn,2026-01-05,09:00,,deposit,T-1001,,,,,,,PLN,,,,20000.00,,,,,,,,,,,Own transfer,examplebroker,Account 12-3456
1,txn,2026-01-07,09:15,,buy,T-1002,ABC,PLABC0000016,ABC Example SA,XWAR,10,62.50,PLN,625.00,3.13,,-628.13,,,,,,,,,,,,,
1,txn,2026-01-12,10:30,,buy,T-1003,WRLD,IE00BEXAMPL1,World Equity UCITS ETF,XETR,3,100.00,EUR,300.00,5.00,,-1281.00,PLN,4.2,,,,,,,,,,,
1,txn,2026-01-14,16:00,,buy,T-1004,XMPL,US0000000001,Example Corp,XNAS,10,100.00,USD,,1.00,,,PLN,4.0,,,,,,,,,cash_amount derived,,
1,txn,2026-01-20,11:00,,sell,O-77,ABC,PLABC0000016,ABC Example SA,XWAR,3,70.00,PLN,210.00,1.00,,209.00,,,,,,,,,,,Fill 1,,
1,txn,2026-01-20,11:00,,sell,O-77,ABC,PLABC0000016,ABC Example SA,XWAR,2,70.10,PLN,140.20,0.75,,139.45,,,,,,,,,,,Fill 2,,
1,txn,2026-01-25,,,dividend,T-1006,XMPL,US0000000001,Example Corp,XNAS,,,USD,10.00,,1.50,8.50,,,,,,,,,,,,,
1,txn,2026-01-31,,,fee,T-1007,,,,,,,PLN,,,,-9.99,,,,,,,,,,,Account fee,,
1,txn,2026-02-02,12:00,,fx_conversion,T-1008,,,,,,,PLN,,,,-400.00,,,,,,,,,,,PLN to USD,,
1,txn,2026-02-02,12:00,,fx_conversion,T-1009,,,,,,,USD,,,,100.00,,,,,,,,,,,PLN to USD,,
1,txn,2026-02-10,,,split,T-1010,XMPL,US0000000001,Example Corp,XNAS,,,USD,,,,,,,4,,,,,,,,4-for-1 split,,
1,rename,2026-02-15,,,,,ABC,PLABC0000016,,XWAR,,,,,,,,,,,,,ABCN,PLABCN000012,,ABC New SA,,Ticker change,,
1,delisting,2026-02-20,,,,,ZZZ,RU0000000009,,,,,,,,,,,,,,,,,,,true,Sanctions,,
1,position,2026-02-28,,,,,ABCN,PLABCN000012,ABC New SA,XWAR,5,,PLN,,,,,,,,62.81,325.00,,,,,,,,
1,position,2026-02-28,,,,,WRLD,IE00BEXAMPL1,World Equity UCITS ETF,XETR,3,,EUR,,,,,,,,101.67,312.00,,,,,,,,
1,position,2026-02-28,,,,,XMPL,US0000000001,Example Corp,XNAS,40,,USD,,,,,,,,25.03,1040.00,,,,,,,,
```

Notes:

- `source` and `account_hint` are set on the first row only (they may be repeated, never changed).
- The `XMPL` buy leaves `cash_amount` empty: it is derived as `-(1000.00 + 1.00) * 4.0 = -4004.00 PLN`.
  The `WRLD` buy gives it explicitly (`-(300.00 + 5.00) * 4.2 = -1281.00 PLN`).
- The two `sell` rows share the order id `O-77`; they stay apart by quantity and price.
- The currency exchange is two `fx_conversion` rows, each with its own ref.
- `ABC` is renamed to `ABCN` on 2026-02-15; the position snapshot therefore lists `ABCN`.

### 10.2 JSON

```json
{
  "format": "cashu-import",
  "format_version": 1,
  "source": "examplebroker",
  "account_hint": "Account 12-3456",
  "records": [
    {"record": "txn", "date": "2026-01-05", "time": "09:00", "type": "deposit", "external_ref": "T-1001", "currency": "PLN", "cash_amount": "20000.00", "note": "Own transfer"},
    {"record": "txn", "date": "2026-01-07", "time": "09:15", "type": "buy", "external_ref": "T-1002", "symbol": "ABC", "isin": "PLABC0000016", "name": "ABC Example SA", "exchange": "XWAR", "quantity": "10", "price": "62.50", "currency": "PLN", "gross_amount": "625.00", "fee": "3.13", "cash_amount": "-628.13"},
    {"record": "txn", "date": "2026-01-12", "time": "10:30", "type": "buy", "external_ref": "T-1003", "symbol": "WRLD", "isin": "IE00BEXAMPL1", "name": "World Equity UCITS ETF", "exchange": "XETR", "quantity": "3", "price": "100.00", "currency": "EUR", "gross_amount": "300.00", "fee": "5.00", "cash_amount": "-1281.00", "cash_currency": "PLN", "fx_rate": "4.2"},
    {"record": "txn", "date": "2026-01-14", "time": "16:00", "type": "buy", "external_ref": "T-1004", "symbol": "XMPL", "isin": "US0000000001", "name": "Example Corp", "exchange": "XNAS", "quantity": "10", "price": "100.00", "currency": "USD", "fee": "1.00", "cash_currency": "PLN", "fx_rate": "4.0", "note": "cash_amount derived"},
    {"record": "txn", "date": "2026-01-20", "time": "11:00", "type": "sell", "external_ref": "O-77", "symbol": "ABC", "isin": "PLABC0000016", "name": "ABC Example SA", "exchange": "XWAR", "quantity": "3", "price": "70.00", "currency": "PLN", "gross_amount": "210.00", "fee": "1.00", "cash_amount": "209.00", "note": "Fill 1"},
    {"record": "txn", "date": "2026-01-20", "time": "11:00", "type": "sell", "external_ref": "O-77", "symbol": "ABC", "isin": "PLABC0000016", "name": "ABC Example SA", "exchange": "XWAR", "quantity": "2", "price": "70.10", "currency": "PLN", "gross_amount": "140.20", "fee": "0.75", "cash_amount": "139.45", "note": "Fill 2"},
    {"record": "txn", "date": "2026-01-25", "type": "dividend", "external_ref": "T-1006", "symbol": "XMPL", "isin": "US0000000001", "name": "Example Corp", "exchange": "XNAS", "currency": "USD", "gross_amount": "10.00", "tax": "1.50", "cash_amount": "8.50"},
    {"record": "txn", "date": "2026-01-31", "type": "fee", "external_ref": "T-1007", "currency": "PLN", "cash_amount": "-9.99", "note": "Account fee"},
    {"record": "txn", "date": "2026-02-02", "time": "12:00", "type": "fx_conversion", "external_ref": "T-1008", "currency": "PLN", "cash_amount": "-400.00", "note": "PLN to USD"},
    {"record": "txn", "date": "2026-02-02", "time": "12:00", "type": "fx_conversion", "external_ref": "T-1009", "currency": "USD", "cash_amount": "100.00", "note": "PLN to USD"},
    {"record": "txn", "date": "2026-02-10", "type": "split", "external_ref": "T-1010", "symbol": "XMPL", "isin": "US0000000001", "name": "Example Corp", "exchange": "XNAS", "currency": "USD", "split_ratio": "4", "note": "4-for-1 split"},
    {"record": "rename", "date": "2026-02-15", "symbol": "ABC", "isin": "PLABC0000016", "exchange": "XWAR", "new_symbol": "ABCN", "new_isin": "PLABCN000012", "new_name": "ABC New SA", "note": "Ticker change"},
    {"record": "delisting", "date": "2026-02-20", "symbol": "ZZZ", "isin": "RU0000000009", "frozen": true, "note": "Sanctions"},
    {"record": "position", "date": "2026-02-28", "symbol": "ABCN", "isin": "PLABCN000012", "name": "ABC New SA", "exchange": "XWAR", "quantity": "5", "currency": "PLN", "avg_price": "62.81", "market_value": "325.00"},
    {"record": "position", "date": "2026-02-28", "symbol": "WRLD", "isin": "IE00BEXAMPL1", "name": "World Equity UCITS ETF", "exchange": "XETR", "quantity": "3", "currency": "EUR", "avg_price": "101.67", "market_value": "312.00"},
    {"record": "position", "date": "2026-02-28", "symbol": "XMPL", "isin": "US0000000001", "name": "Example Corp", "exchange": "XNAS", "quantity": "40", "currency": "USD", "avg_price": "25.03", "market_value": "1040.00"}
  ]
}
```

## 11. Validating a file

Validate before importing; validation needs no database and changes nothing:

```python
from cashu.modules.investments.importing import validate_import_file

report = validate_import_file("converted.csv")   # or .json
print(report.summary())       # counts, then every error and warning with row and field
assert report.ok               # True when the file can be imported
```

`report.errors` lists blocking problems (the import is refused), `report.warnings` lists suspicious but
importable rows. Each entry has `row` (0-based record index, `None` for file-level problems), a message
that starts with the field name (`quantity: must be greater than 0`) and a stable `kind` for grouping
(`invalid_value`, `missing_value`, `unknown_field`, `unmapped_type`, `fx_missing`, `cash_sign`,
`amount_mismatch`, `missing_instrument`, `missing_quantity`, `unknown_split_ratio`, `file_format`, ...). A CLI command (`cashu
investments validate <file>`) comes with the persistence layer.

Checklist for converter authors:

1. Every record has `format_version` 1 (CSV) / the top-level object has `format` and `format_version`
   (JSON), and a valid `record` kind.
2. Dates are `YYYY-MM-DD`, numbers use `.` and no thousands separators, currencies are upper-case codes.
3. Quantities and amounts other than `cash_amount` are never negative; `cash_amount` has the sign of the
   cash movement (a buy is negative).
4. A trade settled in another currency has `cash_currency` plus either `cash_amount` or `fx_rate`.
5. `external_ref` is a stable broker id or empty, never a row number.
6. Run `validate_import_file` and fix every error; read every warning.

## 12. Versioning

This is `format_version` 1. Files without a version or with another version are refused. Any change to
field meanings, required fields or accepted values will come as a new version; the importer will keep
reading version 1 files.

Before the rename to cashU this format was called `finanse-import` (legacy name). Documents with
`"format": "finanse-import"` or `source` `finanse` are still read exactly like the new ids; the old
ids are deprecated, so write `cashu-import` in new converters and connectors.
