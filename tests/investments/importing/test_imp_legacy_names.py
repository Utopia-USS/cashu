"""F11: the investments import format and alias namespace from before the rename (legacy name
"finanse") keep working: old documents parse, stored aliases resolve, dedup hashes stay stable."""

from __future__ import annotations

import json
from datetime import date
from decimal import Decimal

from imp_support import counter_ids, instrument

from cashu.modules.investments.domain import Currency, InstrumentAlias, TxnType
from cashu.modules.investments.importing import (
    CanonicalImporter,
    CurrencyEvidence,
    ImportFile,
    ImportParseResult,
    InMemoryInstrumentLookup,
    InstrumentHint,
    InstrumentMatch,
    InstrumentResolver,
    effective_broker_id,
)
from cashu.modules.investments.importing.canonical import (
    CANONICAL_BROKER_ID,
    LEGACY_BROKER_ID,
    LEGACY_FORMAT,
    canonical_importer_id,
)
from cashu.modules.investments.importing.dedup import DedupInput, dedup_hash

RECORD = {"record": "txn", "date": "2026-10-01", "type": "deposit", "currency": "PLN",
          "gross_amount": "100.00", "external_ref": "R1"}


def _file(fmt: str, **extra) -> ImportFile:
    body = {"format": fmt, "format_version": 1, "records": [RECORD], **extra}
    return ImportFile("old.json", json.dumps(body).encode())


def test_a_document_with_the_legacy_format_id_parses():
    importer = CanonicalImporter()
    old = _file(LEGACY_FORMAT)
    assert importer.can_parse(old)
    result = importer.parse(old)
    assert not result.has_blocking_warnings and len(result.txns) == 1


def test_legacy_source_and_importer_ids_read_as_the_new_ones():
    importer = CanonicalImporter()
    assert importer.broker_id == CANONICAL_BROKER_ID == "cashu"
    assert effective_broker_id(importer, ImportParseResult(source=LEGACY_BROKER_ID)) == "cashu"
    assert effective_broker_id(importer, ImportParseResult(source="xtb")) == "xtb"
    assert canonical_importer_id(LEGACY_BROKER_ID) == "cashu"
    assert canonical_importer_id("generic_csv") == "generic_csv" and canonical_importer_id(None) is None


def test_aliases_stored_under_the_legacy_namespace_still_resolve():
    old = instrument("old", name="Old alias", symbol="QQQ", aliases=(InstrumentAlias(LEGACY_BROKER_ID, "ZZZ"),))
    resolver = InstrumentResolver(
        InMemoryInstrumentLookup([old]), broker_id="cashu", id_factory=counter_ids("new")
    )
    resolved = resolver.resolve(
        InstrumentHint(symbol="ZZZ", currency=Currency.PLN, evidence=CurrencyEvidence.WEAK)
    )
    assert (resolved.match, resolved.instrument_id) == (InstrumentMatch.BROKER_ALIAS, "old")
    assert resolver.new_aliases == {}  # not learned a second time under the new name


def test_dedup_hashes_of_the_canonical_namespace_do_not_change():
    row = DedupInput(
        trade_date=date(2026, 10, 1), type=TxnType.DEPOSIT, gross_amount=Decimal(100),
        cash_amount=Decimal(100), external_ref="R1",
    )
    before_rename = dedup_hash(row, account_id="a1", broker_id=LEGACY_BROKER_ID)
    assert dedup_hash(row, account_id="a1", broker_id="cashu") == before_rename
    assert dedup_hash(row, account_id="a1", broker_id="xtb") != before_rename
