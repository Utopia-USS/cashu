# example-bank-csv (example entry)

**An example, not a real connector.** It converts the CSV statement of the made-up "Przykladowy Bank"
into `cashu-budget-import` v1 JSON and exists to show the catalog layout (`connector.yaml` with
`maintainer` and `last_verified`, the code, this README, synthetic `fixtures/`) and to exercise the
catalog test. Do not install it for real data.

- Kind `file`, module `budget`, extension `csv`; Python 3 standard library only.
- Export: a short preamble (bank name, account number, period), a blank line, then a `;` table with
  DD.MM.YYYY dates and decimal-comma amounts. `detect` recognises the bank's name in the preamble.
- Test: `cashu connectors test connectors/example-bank-csv --file connectors/example-bank-csv/fixtures/sample.csv`
- `fixtures/sample.csv` is synthetic. Same code as `examples/connectors/budget-csv-example`.
