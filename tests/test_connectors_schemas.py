"""The connector JSON Schemas in docs/schemas/ describe the contract (F10). The TypeScript side
(apps/host/scripts/genConnectorSchemas.ts) generates them and checks they are current."""

from __future__ import annotations

import json

from cashu.core import paths

SCHEMAS = paths.PROJECT_ROOT / "docs" / "schemas"


def test_schemas_describe_the_contract():
    manifest = json.loads((SCHEMAS / "connector-manifest.v1.json").read_text(encoding="utf-8"))
    assert manifest["additionalProperties"] is False
    assert set(manifest["required"]) == {"api_version", "id", "name", "version", "module", "kind", "run"}
    protocol = json.loads((SCHEMAS / "connector-protocol.v1.json").read_text(encoding="utf-8"))
    assert set(protocol["messages"]) == {
        "request", "detect_response", "document_response", "check_response", "error_response",
    }
    # requests may grow (connectors ignore unknown keys); responses are strict
    assert "additionalProperties" not in protocol["$defs"]["Request"]
    assert protocol["$defs"]["DocumentResponse"]["additionalProperties"] is False
