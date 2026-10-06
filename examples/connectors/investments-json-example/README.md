# investments-json-example

A `file` connector for the investments module: converts the JSON account history of the made-up
"ExampleBroker" (operations + a holdings snapshot) into `finanse-import` v1 JSON, with the broker's
operation id as `external_ref`. Python 3 standard library only; `detect` checks the `broker` key.

    finanse connectors test examples/connectors/investments-json-example --file examples/connectors/investments-json-example/sample.json

`sample.json` is synthetic. The contract: `docs/connectors.md`.
