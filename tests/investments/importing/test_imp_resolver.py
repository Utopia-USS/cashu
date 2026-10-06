"""Instrument resolution (port of instrument_resolver_test, incl. R10, plus crypto and find)."""

from __future__ import annotations

import pytest
from imp_support import counter_ids, instrument, parsed_txn

from cashu.modules.investments.domain import AssetClass, Currency, InstrumentAlias, TxnType
from cashu.modules.investments.importing import (
    CurrencyEvidence,
    InMemoryInstrumentLookup,
    InstrumentHint,
    InstrumentMatch,
    InstrumentResolver,
)


def hint(
    *,
    symbol: str | None = None,
    isin: str | None = None,
    name: str | None = None,
    exchange: str | None = None,
    currency: Currency = Currency.PLN,
    evidence: CurrencyEvidence = CurrencyEvidence.WEAK,
) -> InstrumentHint:
    return InstrumentHint(
        symbol=symbol,
        isin=isin,
        name=name,
        exchange_hint=exchange,
        currency=currency,
        evidence=evidence,
    )


def resolver_over(*instruments, broker_id: str = "generic_csv") -> InstrumentResolver:
    return InstrumentResolver(
        InMemoryInstrumentLookup(instruments), broker_id=broker_id, id_factory=counter_ids("new")
    )


def test_isin_beats_broker_alias() -> None:
    by_isin = instrument("i1", name="By ISIN", symbol="AAA", isin="PLAAA0000011")
    by_alias = instrument(
        "i2", name="By alias", symbol="BBB", aliases=(InstrumentAlias("generic_csv", "AAA.PL"),)
    )
    resolver = resolver_over(by_isin, by_alias)
    resolved = resolver.resolve(hint(symbol="AAA.PL", isin="plaaa0000011"))
    assert resolved.match == InstrumentMatch.ISIN
    assert resolved.instrument_id == "i1"
    (note,) = resolved.notes
    assert "Broker symbol AAA.PL belongs to By alias" in note
    assert resolver.new_aliases == {}, "the broker symbol is owned by another instrument"


def test_broker_alias_beats_symbol_and_exchange() -> None:
    resolver = resolver_over(
        instrument(
            "alias", name="By alias", symbol="XYZ", aliases=(InstrumentAlias("generic_csv", "PKN"),)
        ),
        instrument("symbol", name="By symbol"),
    )
    resolved = resolver.resolve(hint(symbol="PKN", exchange="GPW"))
    assert (resolved.match, resolved.instrument_id) == (InstrumentMatch.BROKER_ALIAS, "alias")


def test_symbol_and_exchange_then_guessed_market_aliases() -> None:
    orlen = instrument("orlen")
    vanguard = instrument(
        "vwce",
        name="Vanguard",
        symbol="VWRL",
        mic=None,
        aliases=(InstrumentAlias("yahoo", "VWCE.DE"),),
    )
    resolver = resolver_over(orlen, vanguard)
    first = resolver.resolve(hint(symbol="PKN.PL"))
    assert (first.match, first.instrument_id) == (InstrumentMatch.SYMBOL_EXCHANGE, "orlen")
    second = resolver.resolve(hint(symbol="VWCE", exchange="XETRA"))
    assert (second.match, second.instrument_id) == (InstrumentMatch.SYMBOL_EXCHANGE, "vwce")
    assert resolver.new_aliases["orlen"] == (InstrumentAlias("generic_csv", "PKN.PL"),)


def test_nothing_known_plans_a_new_instrument_with_guessed_aliases() -> None:
    resolver = resolver_over()
    resolved = resolver.resolve(
        hint(symbol="PKN", isin="PLPKN0000018", name="Orlen SA", exchange="GPW")
    )
    assert resolved.match == InstrumentMatch.CREATED and resolved.is_new
    planned = resolver.instrument(resolved.instrument_id)
    assert planned is not None and resolver.is_planned(planned.id)
    assert planned.id == "new-1"
    assert planned.needs_classification
    assert (planned.name, planned.symbol, planned.isin, planned.mic) == (
        "Orlen SA",
        "PKN",
        "PLPKN0000018",
        "XWAR",
    )
    assert planned.currency == Currency.PLN
    assert planned.asset_class == AssetClass.EQUITY
    assert planned.aliases == (
        InstrumentAlias("generic_csv", "PKN"),
        InstrumentAlias("stooq", "pkn", guessed=True),
        InstrumentAlias("yahoo", "PKN.WA", guessed=True),
    )
    assert resolver.new_instruments == (planned,)


def test_asset_class_guess_etf_ucits_and_unknown_market() -> None:
    resolver = resolver_over()
    etf = resolver.resolve(
        hint(name="iShares Core MSCI World UCITS ETF USD (Acc)", isin="IE00TEST0001")
    )
    planned_etf = resolver.instrument(etf.instrument_id)
    assert planned_etf.asset_class == AssetClass.ETF
    assert planned_etf.symbol is None
    unknown = resolver.resolve(hint(symbol="ABC"))
    planned = resolver.instrument(unknown.instrument_id)
    assert planned.asset_class == AssetClass.OTHER
    assert planned.mic is None
    assert planned.aliases == (InstrumentAlias("generic_csv", "ABC"),), "no market, no guesses"


def test_crypto_symbols_are_guessed_as_crypto_with_a_yahoo_pair() -> None:
    resolver = resolver_over()
    btc = resolver.instrument(
        resolver.resolve(hint(symbol="BTC", currency=Currency.USD)).instrument_id
    )
    assert btc.asset_class == AssetClass.CRYPTO
    assert btc.symbol == "BTC" and btc.mic is None
    assert btc.alias("yahoo") == "BTC-USD"
    pair = resolver.instrument(
        resolver.resolve(hint(symbol="ETH-USD", exchange="crypto")).instrument_id
    )
    assert pair.asset_class == AssetClass.CRYPTO and pair.symbol == "ETH"
    on_market = resolver.instrument(
        resolver.resolve(hint(symbol="LINK", exchange="XNYS")).instrument_id
    )
    assert on_market.asset_class == AssetClass.EQUITY, "a real market wins over the crypto guess"
    etf = resolver.instrument(
        resolver.resolve(hint(symbol="SOL", name="Solana UCITS ETF")).instrument_id
    )
    assert etf.asset_class == AssetClass.ETF


def test_crypto_resolves_to_an_existing_instrument_by_its_yahoo_pair() -> None:
    stored = instrument(
        "btc",
        name="Bitcoin",
        symbol="BTC",
        mic=None,
        currency=Currency.USD,
        asset_class=AssetClass.CRYPTO,
        aliases=(InstrumentAlias("yahoo", "BTC-USD"),),
    )
    resolver = resolver_over(stored)
    resolved = resolver.resolve(hint(symbol="btcusd", currency=Currency.USD))
    assert (resolved.match, resolved.instrument_id) == (InstrumentMatch.SYMBOL_EXCHANGE, "btc")


def test_us_suffix_guesses_yahoo_and_stooq_without_a_mic() -> None:
    resolver = resolver_over()
    planned = resolver.instrument(
        resolver.resolve(hint(symbol="AAPL.US", currency=Currency.USD)).instrument_id
    )
    assert planned.symbol == "AAPL" and planned.mic is None
    assert planned.alias("yahoo") == "AAPL"
    assert planned.alias("stooq") == "aapl.us"
    assert planned.alias("generic_csv") == "AAPL.US"


def test_one_new_instrument_per_import_later_rows_add_its_isin() -> None:
    resolver = resolver_over()
    first = resolver.resolve(hint(symbol="ZGJ", exchange="GPW", name="ZGJ"))
    again = resolver.resolve(hint(symbol="ZGJ", exchange="GPW", name="ZGJ"))
    with_isin = resolver.resolve(hint(symbol="ZGJ", isin="PLZGJ0000010", exchange="GPW"))
    by_isin_only = resolver.resolve(hint(isin="PLZGJ0000010"))
    assert again == first
    assert (with_isin.instrument_id, with_isin.match) == (
        first.instrument_id,
        InstrumentMatch.BROKER_ALIAS,
    )
    assert (by_isin_only.instrument_id, by_isin_only.match) == (
        first.instrument_id,
        InstrumentMatch.ISIN,
    )
    (planned,) = resolver.new_instruments
    assert planned.isin == "PLZGJ0000010"


def test_planned_instrument_takes_the_currency_of_priced_trades_whatever_the_order_r10() -> None:
    resolver = resolver_over()

    def row(currency: Currency, evidence: CurrencyEvidence, name: str = "Apple") -> InstrumentHint:
        return InstrumentHint(symbol="AAPL.US", name=name, currency=currency, evidence=evidence)

    # Newest-first export: withholding tax and dividend (booked in PLN) before the USD buy.
    tax = resolver.resolve(row(Currency.PLN, CurrencyEvidence.CASH_FLOW))
    assert resolver.instrument(tax.instrument_id).currency == Currency.PLN
    buy = resolver.resolve(row(Currency.USD, CurrencyEvidence.TRADE))
    assert buy.instrument_id == tax.instrument_id
    assert resolver.new_instruments[0].currency == Currency.USD
    assert resolver.instrument(tax.instrument_id).alias("yahoo") == "AAPL", "aliases are kept"
    # A later cash row (or a weaker position line) in PLN does not undo it.
    resolver.resolve(row(Currency.PLN, CurrencyEvidence.WEAK))
    resolver.resolve(row(Currency.PLN, CurrencyEvidence.CASH_FLOW, name="Apple Inc"))
    assert resolver.new_instruments[0].currency == Currency.USD
    # Trade rows that disagree keep the first trade currency and say so once.
    eur = resolver.resolve(row(Currency.EUR, CurrencyEvidence.TRADE))
    assert resolver.new_instruments[0].currency == Currency.USD
    assert eur.notes == (
        "Trade rows of Apple use several currencies (USD, EUR); created it in USD",
    )
    again = resolver.resolve(row(Currency.GBP, CurrencyEvidence.TRADE))
    assert again.notes == (), "noted once"


def test_hint_from_txn_evidence() -> None:
    assert (
        InstrumentHint.from_txn(parsed_txn(TxnType.BUY, price="10")).evidence
        == CurrencyEvidence.TRADE
    )
    assert (
        InstrumentHint.from_txn(parsed_txn(TxnType.TRANSFER_IN, price="10")).evidence
        == CurrencyEvidence.TRADE
    )
    assert (
        InstrumentHint.from_txn(parsed_txn(TxnType.TRANSFER_IN)).evidence == CurrencyEvidence.WEAK
    )
    assert (
        InstrumentHint.from_txn(parsed_txn(TxnType.BUY, price="0")).evidence
        == CurrencyEvidence.WEAK
    )
    assert InstrumentHint.from_txn(parsed_txn(TxnType.SPLIT)).evidence == CurrencyEvidence.WEAK
    assert (
        InstrumentHint.from_txn(parsed_txn(TxnType.DIVIDEND)).evidence == CurrencyEvidence.CASH_FLOW
    )
    assert InstrumentHint.from_txn(parsed_txn(TxnType.TAX)).evidence == CurrencyEvidence.CASH_FLOW


def test_matching_an_existing_instrument_plans_its_missing_isin_and_broker_alias() -> None:
    existing = instrument("orlen", aliases=(InstrumentAlias("generic_csv", "PKN"),))
    resolver = resolver_over(existing)
    resolved = resolver.resolve(hint(symbol="PKN", isin="PLPKN0000018"))
    assert resolved.match == InstrumentMatch.BROKER_ALIAS
    assert resolver.new_aliases == {"orlen": (InstrumentAlias("isin", "PLPKN0000018"),)}

    with_isin = instrument(
        "orlen",
        aliases=(InstrumentAlias("generic_csv", "PKN"), InstrumentAlias("isin", "PLPKN0000018")),
    )
    conflicting = resolver_over(with_isin)
    other = conflicting.resolve(hint(symbol="PKN", isin="PLOTHER00019"))
    assert other.match == InstrumentMatch.BROKER_ALIAS
    assert "ISIN PLOTHER00019 of the row differs from Orlen" in other.notes[0]
    assert conflicting.new_aliases == {}


def test_ambiguous_symbol_and_mic_uses_the_oldest_and_says_so() -> None:
    resolver = resolver_over(
        instrument("old", name="Old", symbol="DUP"), instrument("new", name="New", symbol="DUP")
    )
    resolved = resolver.resolve(hint(symbol="DUP", exchange="XWAR"))
    assert resolved.instrument_id == "old"
    assert "matches 2 instruments" in resolved.notes[0]


def test_an_empty_hint_is_rejected() -> None:
    with pytest.raises(ValueError):
        resolver_over().resolve(hint(symbol=" "))
    assert hint(symbol=" ", isin="", name=None).is_empty


def test_find_never_plans() -> None:
    resolver = resolver_over(instrument("orlen", isin="PLPKN0000018"))
    assert resolver.find(symbol="XYZ") is None
    assert resolver.new_instruments == ()
    found = resolver.find(symbol="ignored", isin="plpkn0000018")
    assert found is not None and found.instrument_id == "orlen"
    assert resolver.find() is None
    planned = resolver.resolve(hint(symbol="NEW", exchange="GPW"))
    assert resolver.find(symbol="NEW").instrument_id == planned.instrument_id


def test_in_memory_lookup() -> None:
    lookup = InMemoryInstrumentLookup(
        [instrument("a", isin="PLAAA0000011", aliases=(InstrumentAlias("isin", "PLAAA0000029"),))]
    )
    assert lookup.by_isin("plaaa0000011").id == "a"
    assert lookup.by_alias("isin", "PLAAA0000029").id == "a"
    assert lookup.by_symbol("pkn", "XWAR")[0].id == "a"
    assert lookup.by_symbol("pkn", "XNAS") == []
    lookup.add(instrument("b", symbol="B", aliases=(InstrumentAlias("xtb", "B.US"),)))
    assert lookup.by_alias("xtb", "B.US").id == "b"
