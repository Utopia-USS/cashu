"""F11: pre-rename names (legacy name "finanse") that stay accepted: the budget import format and
importer ids, finanse:// links, the notification helper key of older app builds."""

from __future__ import annotations

import json
import plistlib

from cashu.core.worker import notifier_app
from cashu.desktop.notify import link_to_hash
from cashu.modules.budget import imports
from cashu.modules.budget.ingestion.canonical import (
    FORMAT,
    IMPORTER_ID,
    LEGACY_FORMAT,
    LEGACY_IMPORTER_ID,
    looks_like_budget_document,
    parse_budget_document,
)

DOC = {
    "format_version": 1,
    "account": {"currency": "PLN", "name": "Konto Test"},
    "transactions": [{"booking_date": "2026-10-04", "amount": "-42.10", "currency": "PLN",
                      "description": "ZAKUP TEST"}],
}


def test_a_budget_document_with_the_legacy_format_id_parses():
    data = json.dumps({"format": LEGACY_FORMAT, **DOC}).encode()
    assert looks_like_budget_document(data, "old.json")
    result = parse_budget_document(data, "old.json")
    assert result.ok and len(result.statement.transactions) == 1
    assert parse_budget_document(json.dumps({"format": FORMAT, **DOC}).encode(), "x.json").ok
    assert not parse_budget_document(json.dumps({"format": "other", **DOC}).encode(), "x.json").ok


def test_the_legacy_budget_importer_id_selects_the_format():
    assert imports.normalized_choice(LEGACY_IMPORTER_ID) == IMPORTER_ID == "cashu-budget"
    assert imports.normalized_choice(" ") == imports.AUTO


def test_legacy_links_still_open_a_view():
    assert link_to_hash("cashu://open") == ""
    assert link_to_hash("finanse://open") == ""  # legacy name
    assert link_to_hash("finanse://signal/jan/7") == link_to_hash("cashu://signal/jan/7")
    assert link_to_hash("other://open") is None


def test_an_older_app_build_with_the_legacy_helper_key_is_used(tmp_path):
    app = tmp_path / "cashU.app"
    exe = app / "Contents" / "MacOS" / "finanse"  # legacy name: older builds' executable
    exe.parent.mkdir(parents=True)
    exe.write_text("#!/bin/sh\n")
    exe.chmod(0o755)
    info = {"CFBundleExecutable": "finanse", "FinanseNotificationHelper": True}  # legacy name
    (app / "Contents" / "Info.plist").write_bytes(plistlib.dumps(info))
    found = notifier_app.inspect_bundle(app)
    assert found is not None and found.executable == exe
