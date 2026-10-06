"""Contract types, the importer registry and exchange hints."""

from __future__ import annotations

from dataclasses import FrozenInstanceError

import pytest
from imp_support import csv_file, d, day, parsed_txn, pl_mapping

from cashu.modules.investments.domain import Currency, TxnType
from cashu.modules.investments.importing import (
    CRYPTO,
    BrokerImporter,
    CanonicalImporter,
    DuplicateImporterError,
    GenericCsvImporter,
    ImporterRegistry,
    ImportFile,
    ImportParseResult,
    ImportWarning,
    ParsedCorporateAction,
    ParsedDelisting,
    ParsedRename,
    crypto_base,
    default_registry,
    effective_broker_id,
    exchange_for_hint,
    exchange_for_mic,
    is_crypto_symbol,
    split_broker_symbol,
)
from cashu.modules.investments.importing.exchanges import MARKETS


def test_import_file_extension() -> None:
    assert ImportFile("Export.CSV", b"").extension == "csv"
    assert ImportFile("archive.tar.gz", b"").extension == "gz"
    assert ImportFile("noext", b"").extension == ""
    assert ImportFile(".hidden", b"").extension == ""


def test_parse_result_converts_lists_and_reports_blocking() -> None:
    txn = parsed_txn(TxnType.BUY, price="10")
    result = ImportParseResult(
        txns=[txn],
        warnings=[ImportWarning(message="a"), ImportWarning(message="b", row=3, blocking=True)],
    )
    assert isinstance(result.txns, tuple)
    assert isinstance(result.warnings, tuple)
    assert result.has_blocking_warnings
    assert str(result.warnings[1]) == "row 3: b (blocking)"
    assert str(result.warnings[0]) == "a"
    assert not ImportParseResult().has_blocking_warnings
    with pytest.raises(FrozenInstanceError):
        result.account_hint = "x"  # type: ignore[misc]


def test_parsed_txn_is_hashable_and_raw_row_is_not_part_of_the_hash() -> None:
    txn = parsed_txn(TxnType.BUY)
    assert hash(txn) == hash(parsed_txn(TxnType.BUY))
    assert txn.fee == 0 and txn.tax == 0
    assert txn.instrument_named()
    assert not parsed_txn(TxnType.DEPOSIT, symbol="  ").instrument_named()


def test_corporate_actions_are_one_family() -> None:
    rename = ParsedRename(date=day("2026-02-01"), old_symbol="ABC", new_symbol="ABCN")
    delisting = ParsedDelisting(date=day("2026-02-02"), symbol="ZZZ", frozen=True)
    assert isinstance(rename, ParsedCorporateAction)
    assert isinstance(delisting, ParsedCorporateAction)
    assert rename.row_index is None and delisting.frozen


def test_importers_satisfy_the_protocol() -> None:
    assert isinstance(GenericCsvImporter(pl_mapping()), BrokerImporter)
    assert isinstance(CanonicalImporter(), BrokerImporter)


class _Fake:
    def __init__(self, broker_id: str, accepts: bool = True, explode: bool = False) -> None:
        self.broker_id = broker_id
        self.display_name = broker_id.upper()
        self.version = 1
        self._accepts = accepts
        self._explode = explode

    def can_parse(self, file: ImportFile) -> bool:
        if self._explode:
            raise RuntimeError("sniff failed")
        return self._accepts

    def parse(self, file: ImportFile) -> ImportParseResult:
        return ImportParseResult()


def test_registry_register_get_detect() -> None:
    first, second, broken, other = (
        _Fake("a"),
        _Fake("b"),
        _Fake("c", explode=True),
        _Fake("d", accepts=False),
    )
    registry = ImporterRegistry([first, broken, second, other])
    assert registry.importers == (first, broken, second, other)
    assert registry.get("b") is second
    assert registry.get("zzz") is None
    assert "a" in registry and len(registry) == 4
    assert registry.detect(csv_file("x")) == (first, second), "throwing sniffs are no match"
    with pytest.raises(DuplicateImporterError):
        registry.register(_Fake("a"))


def test_default_registry_puts_the_canonical_importer_first() -> None:
    registry = default_registry(pl_mapping())
    assert [importer.broker_id for importer in registry.importers] == ["cashu", "generic_csv"]


def test_effective_broker_id_prefers_the_file_source() -> None:
    importer = CanonicalImporter()
    assert effective_broker_id(importer, ImportParseResult()) == "cashu"
    assert (
        effective_broker_id(importer, ImportParseResult(source="examplebroker")) == "examplebroker"
    )


def test_exchange_hints() -> None:
    assert exchange_for_hint("gpw").mic == "XWAR"
    assert exchange_for_hint(".PL").mic == "XWAR"
    assert exchange_for_hint("NASDAQ").stooq_symbol("AAPL") == "aapl.us"
    assert exchange_for_hint("LSE").yahoo_symbol("vusa") == "VUSA.L"
    assert exchange_for_hint("Mars") is None
    assert exchange_for_hint("  ") is None
    assert exchange_for_hint(None) is None
    assert exchange_for_hint("BE") is None, "Belgium at some brokers, Berlin at Yahoo"
    assert exchange_for_mic("xetr").yahoo_suffix == ".DE"
    assert exchange_for_hint("US").mic is None and exchange_for_hint("US").yahoo_symbol("x") == "X"


@pytest.mark.parametrize(
    ("mic", "suffix", "currency"),
    [
        ("XNAS", "", "USD"),
        ("XNYS", "", "USD"),
        ("ARCX", "", "USD"),
        ("BATS", "", "USD"),
        ("XWAR", ".WA", "PLN"),
        ("XLON", ".L", "GBP"),
        ("XASX", ".AX", "AUD"),
        ("XTSE", ".TO", "CAD"),
        ("XTSX", ".V", "CAD"),
        ("XHKG", ".HK", "HKD"),
        ("XPAR", ".PA", "EUR"),
        ("XAMS", ".AS", "EUR"),
        ("XBRU", ".BR", "EUR"),
        ("XETR", ".DE", "EUR"),
        ("XMIL", ".MI", "EUR"),
        ("XMAD", ".MC", "EUR"),
        ("XSWX", ".SW", "CHF"),
        ("XSTO", ".ST", "SEK"),
        ("XCSE", ".CO", "DKK"),
        ("XOSL", ".OL", "NOK"),
        ("XHEL", ".HE", "EUR"),
    ],
)
def test_market_table(mic: str, suffix: str, currency: str) -> None:
    market = MARKETS[mic]
    assert market.yahoo_suffix == suffix
    assert market.currency == Currency(currency)
    assert exchange_for_hint(mic) is market


def test_crypto_pseudo_market_and_symbols() -> None:
    assert exchange_for_hint("crypto") is CRYPTO
    assert CRYPTO.yahoo_symbol("btc") == "BTC-USD"
    assert CRYPTO.mic is None and CRYPTO.crypto
    assert crypto_base("BTC") == "BTC"
    assert crypto_base("btc-usd") == "BTC"
    assert crypto_base("ETH/EUR") == "ETH"
    assert crypto_base("BTCUSD") == "BTC"
    assert crypto_base("USDC") == "USDC"
    assert crypto_base("AAPL") is None
    assert crypto_base("BTC-XYZ") is None
    assert not is_crypto_symbol(None)


def test_split_broker_symbol() -> None:
    assert split_broker_symbol("PKN.PL", None).symbol == "PKN"
    assert split_broker_symbol("PKN.PL", None).exchange.mic == "XWAR"
    assert split_broker_symbol("BRK.B", None).symbol == "BRK.B"
    assert split_broker_symbol("BRK.B", None).exchange is None
    assert split_broker_symbol("VWCE.DE", "XETRA").symbol == "VWCE"
    assert split_broker_symbol("VWCE.DE", "GPW").symbol == "VWCE.DE", "suffix contradicts the hint"
    assert split_broker_symbol("AAPL.US", "NASDAQ").exchange.mic == "XNAS", "US suffix has no MIC"
    assert split_broker_symbol(" PKN ", "GPW").symbol == "PKN"


def test_warning_values() -> None:
    assert ImportWarning(message="m") == ImportWarning(message="m", row=None, blocking=False)
    assert d("1") == 1


def test_us_venues_are_complete() -> None:
    for mic in ("XNAS", "XNYS", "ARCX", "BATS", "XASE", "IEXG"):
        market = exchange_for_hint(mic)
        assert market is not None and market.mic == mic
        assert (market.yahoo_suffix, market.stooq_suffix, market.currency) == ("", ".us", "USD")
    assert exchange_for_hint("AMEX").mic == "XASE"
    assert exchange_for_hint("NYSE American".replace(" ", "")).mic == "XASE"
    assert exchange_for_hint("IEX").mic == "IEXG"


def test_ticker_colon_mic_form() -> None:
    nvda = split_broker_symbol("NVDA:xnas", None)
    assert (nvda.symbol, nvda.exchange.mic) == ("NVDA", "XNAS")
    cdr = split_broker_symbol("CDR:XWAR", "gpw")
    assert (cdr.symbol, cdr.exchange.mic) == ("CDR", "XWAR")
    assert split_broker_symbol("CDR:xwar", "XNAS").symbol == "CDR:xwar", "contradicts the hint"
    assert split_broker_symbol("BRK.B:xnys", None).symbol == "BRK.B"
    assert split_broker_symbol("ABC:FOO", None).symbol == "ABC:FOO"


def test_hong_kong_yahoo_symbols_are_padded_to_four_digits() -> None:
    hk = exchange_for_mic("XHKG")
    assert hk.yahoo_symbol("700") == "0700.HK"
    assert hk.yahoo_symbol("00700") == "0700.HK"
    assert hk.yahoo_symbol("9988") == "9988.HK"
    assert hk.yahoo_symbol("12345") == "12345.HK"
    assert hk.yahoo_symbol("ABC") == "ABC.HK"
    assert exchange_for_mic("XWAR").yahoo_symbol("700") == "700.WA", "only Hong Kong pads"


def test_warning_kinds() -> None:
    from cashu.modules.investments.importing import ImportWarningKind

    assert ImportWarning(message="m").kind == ImportWarningKind.OTHER == "other"
    warning = ImportWarning(message="m", kind=ImportWarningKind.FX_MISSING)
    assert warning.kind == "fx_missing"
    assert ImportWarningKind("unmapped_type") == ImportWarningKind.UNMAPPED_TYPE
    assert {"unknown_split_ratio", "history_gap_hint", "fx_missing"} <= {
        k.value for k in ImportWarningKind
    }
