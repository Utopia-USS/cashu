# deno-budget-example

A `file` connector for the budget module in TypeScript on Deno (the app ships Deno): converts the `;`
CSV statement of the made-up "Bank Testowy" into `cashu-budget-import` v1 JSON. `connector.ts` speaks
the protocol, `parse.ts` (a relative import) parses; no npm, jsr or https imports.

    test_connector(path=<workspace>/connectors/deno-budget-example, file=<workspace>/inbox/sample.csv)
    cashu connectors test examples/connectors/deno-budget-example --file examples/connectors/deno-budget-example/sample.csv

`sample.csv` is synthetic. The contract: `docs/connectors.md`.
