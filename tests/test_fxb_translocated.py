"""GET /mcp and the module setup payload flag an App-Translocated app (F7, FXP request 4), so the UI
can show its ``translocated`` label next to the placeholder snippet."""

from __future__ import annotations

import sys

from finanse.core import runtime

APP_EXE = "/Applications/Finanse.app/Contents/MacOS/finanse"
MOVED_EXE = "/private/var/folders/x/T/AppTranslocation/ABC/d/Finanse.app/Contents/MacOS/finanse"


def test_translocated_flag_on_mcp_and_module_setup(api_empty, monkeypatch, tmp_path):
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "_MEIPASS", str(tmp_path), raising=False)
    slug = api_empty.post(
        "/api/profiles", json={"name": "Test", "modules": ["investments", "budget"]}
    ).json()["slug"]

    monkeypatch.setattr(sys, "executable", APP_EXE)
    assert api_empty.get(f"/api/p/{slug}/mcp").json()["translocated"] is False
    setup = api_empty.get(f"/api/p/{slug}/modules/investments/setup").json()
    assert setup["skill"]["translocated"] is False

    monkeypatch.setattr(sys, "executable", MOVED_EXE)
    assert runtime.translocated()
    info = api_empty.get(f"/api/p/{slug}/mcp").json()
    assert info["translocated"] is True and info["claude_mcp_add"] == runtime.TRANSLOCATED_SNIPPET
    for module in ("investments", "budget"):
        skill = api_empty.get(f"/api/p/{slug}/modules/{module}/setup").json()["skill"]
        assert skill["translocated"] is True and skill["mcp_add"] == runtime.TRANSLOCATED_SNIPPET
