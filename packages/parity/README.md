# @cashu/parity

Compares a TypeScript output dir against the Python goldens (`parity/README.md`, scope S02).
Scope S03 of the TS migration.

```bash
pnpm parity --dataset demo --actual parity/golden-demo      # synthetic goldens, committed
pnpm parity --dataset lab --actual <dir> [--check core.*]   # real-data goldens, never printed
```

Output per check: `pass` / `fail` / `missing`, row counts, short sha256 of the golden and actual
files and, on failure, the JSON path and kind of the **first** difference. Values are never printed
(the lab goldens are real data). A missing actual dir or file gives `missing`; byte-identical files
pass without parsing (`--deep` forces the tree comparison). Exit code: 0 all pass, 1 a check
failed, 2 only missing (`--allow-missing` turns that into 0), 64 usage, 70 golden/config problem.

Defaults: lab goldens `~/cashu-lab/parity/out/lab` (`$CASHU_LAB_DIR` moves the lab root), demo
goldens `parity/golden-demo`, actual `~/cashu-lab/parity/ts-out/<dataset>`.

## Comparison rules

- Objects are unordered, arrays ordered. Duplicate keys and `NaN` literals are parse errors.
- Integers are exact (`bigint`). Floats: equal when `|a-b| <= absTol` or `<= relTol * max(|a|,|b|)`,
  default `absTol 1e-9`, `relTol 1e-12`. An integer against a float compares as numbers (a TS
  producer cannot write `1.0`).
- Decimal strings (Python `Decimal` as `str()`) feed hashes, so the default is an exact string
  match: `"1.0"` vs `"1.00"` fails. Per check, `"decimal": "numeric"` accepts strings that denote
  the same number (`"1.0"` = `"1.00"`, `"1E+1"` = `"10"`), still with no tolerance. It applies to
  every digit-like string in that check, so use it only where scale is not part of the contract.
- Paths print schema-like keys (`snake_case` fields, `$label`, natural keys, currency codes, ISO
  dates); any other object key could be data and prints as `<key:8 hex of sha256>`. `--hash-keys`
  hashes all keys.

## Tolerance config

`parity.config.json` (override with `--config`); unknown keys and unknown check names are errors:

```json
{
  "default": { "absTol": 1e-9, "relTol": 1e-12, "decimal": "exact" },
  "checks": {
    "investments.performance": { "absTol": 1e-6 },
    "core.networth": { "decimal": "numeric" }
  }
}
```

Precedence: built-in defaults < `default` < `checks.<name>`.
