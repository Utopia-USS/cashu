# budget-csv-example

A `file` connector for the budget module: converts the CSV statement of the made-up "Przykladowy Bank"
(preamble with the account number, `;` table, DD.MM.YYYY dates, decimal comma) into
`cashu-budget-import` v1 JSON. Python 3 standard library only; `detect` recognises the bank's header.

    cashu connectors test examples/connectors/budget-csv-example --file examples/connectors/budget-csv-example/sample.csv

`sample.csv` is synthetic. The contract: `docs/connectors.md`.
