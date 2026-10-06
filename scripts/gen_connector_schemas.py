#!/usr/bin/env python3
"""Generate the connector JSON Schemas in ``docs/schemas/`` from the pydantic models.

- ``connector-manifest.v1.json``: ``connector.yaml`` (``cashu.core.connectors.manifest.Manifest``);
- ``connector-protocol.v1.json``: the stdin request and the stdout responses
  (``cashu.core.connectors.protocol``);
- ``cashu-budget-import.v1.json``: the budget import document, JSON variant
  (``cashu.modules.budget.ingestion.canonical.BudgetImportDocument``, docs/budget-import-format.md);
- ``cashu-import.v1.json``: the investments import document, JSON variant (built from the canonical
  importer's field tables, ``cashu.modules.investments.importing.canonical``, docs/import-format.md).

Connector authors (and their agents) validate against these; the models stay the source of truth. Run
after changing a model:

    python scripts/gen_connector_schemas.py          # write the schemas
    python scripts/gen_connector_schemas.py --check  # exit 1 when a schema is stale (the tests run it)
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from pydantic.json_schema import models_json_schema

from cashu.core.connectors import manifest, protocol

SCHEMAS = ROOT / "docs" / "schemas"
DRAFT = "https://json-schema.org/draft/2020-12/schema"


def manifest_schema() -> dict:
    schema = manifest.Manifest.model_json_schema()
    return {
        "$schema": DRAFT,
        "$id": "connector-manifest.v1.json",
        "title": "cashU connector manifest (connector.yaml), api_version 1",
        "description": (
            "Generated from cashu.core.connectors.manifest.Manifest by "
            "scripts/gen_connector_schemas.py; see docs/connectors.md. The app also enforces the "
            "rules a schema cannot express: run[0] is an allowed interpreter or ./<file>, no `..` or "
            "absolute paths in run, the file / fetch section matches kind, unique ids, directory "
            "limits."
        ),
        **{k: v for k, v in schema.items() if k not in ("title", "description")},
    }


PROTOCOL_MODELS = {
    "request": protocol.Request,
    "detect_response": protocol.DetectResponse,
    "document_response": protocol.DocumentResponse,
    "check_response": protocol.CheckResponse,
    "error_response": protocol.ErrorResponse,
}


def protocol_schema() -> dict:
    refs, top = models_json_schema(
        [(model, "validation") for model in PROTOCOL_MODELS.values()],
        ref_template="#/$defs/{model}",
    )
    names = {model: name for name, model in PROTOCOL_MODELS.items()}
    return {
        "$schema": DRAFT,
        "$id": "connector-protocol.v1.json",
        "title": "cashU connector protocol, api_version 1",
        "description": (
            "Generated from cashu.core.connectors.protocol by scripts/gen_connector_schemas.py; "
            "see docs/connectors.md. stdin: request. stdout with exit code 0: detect_response "
            "(detect), document_response (convert, fetch), check_response (check); with exit code 1: "
            "error_response. Known error kinds: " + ", ".join(protocol.CONNECTOR_ERROR_KINDS) + "."
        ),
        "messages": {
            names[model]: refs[(model, "validation")] for model in PROTOCOL_MODELS.values()
        },
        "$defs": top["$defs"],
    }


def budget_import_schema() -> dict:
    from cashu.modules.budget.ingestion import canonical

    schema = canonical.BudgetImportDocument.model_json_schema(mode="validation")
    return {
        "$schema": DRAFT,
        "$id": "cashu-budget-import.v1.json",
        "title": "cashU budget import document (cashu-budget-import), format_version 1",
        "description": (
            "Generated from cashu.modules.budget.ingestion.canonical.BudgetImportDocument by "
            "scripts/gen_connector_schemas.py; see docs/budget-import-format.md (also the CSV "
            "variant). The app also enforces what a schema cannot express: real calendar dates, at "
            "most 2 decimal places (3 for BHD, IQD, JOD, KWD, LYD, OMR, TND), unique transaction_id."
        ),
        **{k: v for k, v in schema.items() if k not in ("title", "description")},
    }


def investments_import_schema() -> dict:
    """The ``cashu-import`` JSON variant from the canonical importer's tables (it has no pydantic
    model): top-level keys, the record fields allowed per record kind, value formats and limits."""
    from cashu.modules.investments.domain import TxnType
    from cashu.modules.investments.importing import canonical as c

    decimal = {
        "description": "a decimal number: a JSON number or a string with '.' as decimal separator",
        "anyOf": [{"type": "number"}, {"type": "string", "pattern": r"^-?[0-9]+(\.[0-9]+)?$"}],
    }
    date = {"type": "string", "pattern": r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$"}
    currency = {"type": "string", "pattern": r"^[A-Z]{3}$"}
    isin = {"type": "string", "pattern": r"^[A-Z]{2}[A-Z0-9]{9}[0-9]$"}

    def text(limit: int) -> dict:
        return {"type": "string", "maxLength": limit}

    fields: dict[str, dict] = {
        "record": {"enum": [k.value for k in c.RecordKind]},
        "date": date,
        "time": {"type": "string", "pattern": r"^[0-9]{2}:[0-9]{2}(:[0-9]{2})?$"},
        "settle_date": date,
        "type": {"enum": [t.value for t in TxnType]},
        "external_ref": text(c.MAX_REF),
        "symbol": text(c.MAX_SYMBOL),
        "isin": isin,
        "name": text(c.MAX_NAME),
        "exchange": text(c.MAX_SYMBOL),
        "quantity": decimal,
        "price": decimal,
        "currency": currency,
        "gross_amount": decimal,
        "fee": decimal,
        "tax": decimal,
        "cash_amount": decimal,
        "cash_currency": currency,
        "fx_rate": decimal,
        "split_ratio": decimal,
        "avg_price": decimal,
        "market_value": decimal,
        "new_symbol": text(c.MAX_SYMBOL),
        "new_isin": isin,
        "new_exchange": text(c.MAX_SYMBOL),
        "new_name": text(c.MAX_NAME),
        "frozen": {"anyOf": [{"type": "boolean"}, {"enum": ["true", "false"]}]},
        "note": text(c.MAX_NOTE),
    }
    missing = set(c.RECORD_FIELDS) - set(fields)
    if missing:  # a new field in the importer must get a schema entry here
        raise SystemExit(f"no schema for record fields: {sorted(missing)}")
    per_kind = [
        {
            "if": {"properties": {"record": {"const": kind.value}}},
            "then": {
                "propertyNames": {
                    "enum": [name for name, kinds in c.RECORD_FIELDS.items() if kind in kinds]
                }
            },
        }
        for kind in c.RecordKind
    ]
    return {
        "$schema": DRAFT,
        "$id": "cashu-import.v1.json",
        "title": "cashU investments import document (cashu-import), format_version 1",
        "description": (
            "Built from cashu.modules.investments.importing.canonical by "
            "scripts/gen_connector_schemas.py; see docs/import-format.md (also the CSV variant). The "
            "app also enforces what a schema cannot express: real calendar dates, the instrument and "
            "quantity rules per transaction type, cash sign rules, gross / fee / tax / cash "
            "consistency."
        ),
        "type": "object",
        "additionalProperties": False,
        "required": ["format", "format_version", "records"],
        "properties": {
            "format": {"const": c.CANONICAL_FORMAT},
            "format_version": {"const": c.CANONICAL_FORMAT_VERSION},
            "source": {"type": "string", "pattern": r"^[a-z][a-z0-9_]*$", "maxLength": c.MAX_SOURCE},
            "account_hint": text(c.MAX_ACCOUNT_HINT),
            "records": {"type": "array", "items": {"$ref": "#/$defs/record"}},
        },
        "$defs": {
            "record": {
                "type": "object",
                "required": ["record", "date"],
                "properties": fields,
                "additionalProperties": False,
                "allOf": per_kind,
            }
        },
    }


def render(schema: dict) -> str:
    return json.dumps(schema, indent=2, ensure_ascii=False, sort_keys=False) + "\n"


OUTPUTS = {
    "connector-manifest.v1.json": manifest_schema,
    "connector-protocol.v1.json": protocol_schema,
    "cashu-budget-import.v1.json": budget_import_schema,
    "cashu-import.v1.json": investments_import_schema,
}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="only report stale schemas")
    args = parser.parse_args(argv)
    stale = []
    for name, build in OUTPUTS.items():
        target = SCHEMAS / name
        wanted = render(build())
        current = target.read_text(encoding="utf-8") if target.is_file() else None
        if current == wanted:
            continue
        stale.append(name)
        if not args.check:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(wanted, encoding="utf-8")
    if args.check and stale:
        print(
            "Stale connector schemas (run `python scripts/gen_connector_schemas.py`): "
            + ", ".join(stale),
            file=sys.stderr,
        )
        return 1
    for name in stale:
        print(f"updated docs/schemas/{name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
