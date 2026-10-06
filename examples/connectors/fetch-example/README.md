# fetch-example

A `fetch` connector for the investments module: pages through the history of the made-up ExampleExchange
API (`api.example.com`, read-only key in `secrets.api_key`) via urllib and the app's `HTTPS_PROXY`,
returns `cashu-import` v1 JSON and the newest entry id as the cursor; `check` tests the key.
Offline test (the fixture's text arrives as `params.fixture`, no network, a placeholder key):

    cashu connectors test examples/connectors/fetch-example --fixture examples/connectors/fetch-example/fixture.json

`fixture.json` is synthetic. The contract: `docs/connectors.md`.
