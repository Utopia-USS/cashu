"""The connector JSON Schemas in docs/schemas/ are generated from the pydantic models and current (F10)."""

from __future__ import annotations

import json
import subprocess
import sys

from finanse.core import paths

SCRIPT = paths.PROJECT_ROOT / "scripts" / "gen_connector_schemas.py"
SCHEMAS = paths.PROJECT_ROOT / "docs" / "schemas"


def test_connector_schemas_are_current():
    res = subprocess.run(
        [sys.executable, str(SCRIPT), "--check"], capture_output=True, text=True, check=False
    )
    assert res.returncode == 0, res.stderr


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
