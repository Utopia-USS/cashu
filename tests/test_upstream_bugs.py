"""Regression tests for the upstream bugs found in the F0 baseline (B1-B5; B6 is
the frontend type check). Synthetic data only."""

from datetime import date
from decimal import Decimal

from cashu.models import Source, Transaction
from cashu.modules.budget.categorize import taxonomy
from cashu.modules.budget.categorize.engine import categorize


def _txn(amount: str, title: str, *, cp: str | None = None, iban: str | None = None,
         currency: str = "PLN", day: date = date(2026, 8, 10)) -> Transaction:
    return Transaction(
        account_id=1, booking_date=day, amount=Decimal(amount), currency=currency,
        counterparty_name=cp, counterparty_iban=iban, reference=title, description=title,
        source=Source.CSV, dedup_hash=f"h-{title}-{amount}-{day}", occurrence=0,
    )


def _cat(t: Transaction, subs: set[str] | None = None) -> tuple[str, str]:
    return categorize(t, own_ibans=set(), rules={}, subscription_keys=subs or set())


# --------------------------------------------------------------------------- #
# B1 - seed rules shadowed by an earlier, more generic rule
# --------------------------------------------------------------------------- #

def test_b1_salary_titled_wyplata_wynagrodzenia_is_salary():
    assert _cat(_txn("9000.00", "WYPŁATA WYNAGRODZENIA ZA 08/2026")) == ("income_salary", "keyword")


def test_b1_atm_and_cash_withdrawals_stay_cash():
    assert _cat(_txn("-300.00", "WYPŁATA W BANKOMACIE TEST")) == ("cash", "keyword")
    assert _cat(_txn("-200.00", "WYPŁATA GOTÓWKI TEST")) == ("cash", "keyword")


def test_b1_no_seed_rule_is_unreachable():
    """First match wins, so a rule whose needle contains an earlier rule's needle
    (with a different category) can never fire."""
    dead = []
    for j, (needle, cat) in enumerate(taxonomy.SEED_RULES):
        for earlier, earlier_cat in taxonomy.SEED_RULES[:j]:
            if earlier in needle and earlier_cat != cat:
                dead.append(f"{needle!r}->{cat} shadowed by {earlier!r}->{earlier_cat}")
                break
    assert dead == []


def test_b1_sephora_is_shopping():
    assert taxonomy.apply_seed_rules("SEPHORA TEST KRAKOW") == "shopping"


# --------------------------------------------------------------------------- #
# B2 - loan / mortgage / rent / fee installments detected as subscriptions,
#      and subscription totals mixing currencies
# --------------------------------------------------------------------------- #

def _monthly(session, account, title, amount, *, cp=None, iban=None, currency="PLN", day=5):
    from cashu.modules.budget.ingestion.normalize import RawTransaction
    from cashu.modules.budget.service import ingest_transactions

    raws = [
        RawTransaction(
            booking_date=date(2026, m, day), amount=Decimal(amount), currency=currency,
            counterparty_name=cp, counterparty_iban=iban, reference=title, description=title,
            source=Source.CSV,
        )
        for m in (5, 6, 7, 8)
    ]
    ingest_transactions(session, account, raws, source=Source.CSV)


def _seed_recurring_mix(session):
    from cashu.core.accounts import get_or_create_account

    pln = get_or_create_account(session, bank="mbank", iban="99114000000000000000000001")
    eur = get_or_create_account(session, bank="mbank", iban="99114000000000000000000002",
                                currency="EUR")
    session.flush()
    # not subscriptions
    _monthly(session, pln, "RATA KREDYTU HIPOTECZNEGO", "-3000.00", cp="BANK HIPOTECZNY TEST",
             iban="99160000000000000000000555", day=5)
    _monthly(session, pln, "SPŁATA KREDYTU", "-1412.37", day=15)
    _monthly(session, pln, "CZYNSZ", "-650.00", cp="WSPOLNOTA MIESZKANIOWA TEST", day=3)
    _monthly(session, pln, "CZYNSZ ZA MIESZKANIE", "-2500.00", cp="JAN TESTOWY", day=1)
    _monthly(session, pln, "WYPŁATA W BANKOMACIE TEST", "-300.00", day=16)
    _monthly(session, pln, "OPŁATA ZA KARTĘ", "-7.00", day=28)
    _monthly(session, pln, "ZUS SKLADKA TEST", "-1600.00", day=20)
    # real subscriptions
    _monthly(session, pln, "NETFLIX.COM", "-43.00", day=7)
    _monthly(session, pln, "KLUB SPORTOWY TEST", "-139.00", day=2)
    _monthly(session, eur, "SPOTIFY TEST", "-9.99", currency="EUR", day=14)
    session.flush()


def test_b2_loan_installment_is_not_a_subscription_category():
    mortgage = _txn("-3000.00", "RATA KREDYTU HIPOTECZNEGO", cp="BANK HIPOTECZNY TEST")
    assert _cat(mortgage, subs={"BANK HIPOTECZNY TEST"}) == ("loans", "keyword")
    car_loan = _txn("-1412.37", "SPŁATA KREDYTU")
    assert _cat(car_loan, subs={"SPLATA KREDYTU"}) == ("loans", "keyword")
    private_rent = _txn("-2500.00", "CZYNSZ ZA MIESZKANIE", cp="JAN TESTOWY")
    assert _cat(private_rent, subs={"JAN TESTOWY"}) == ("housing", "keyword")
    # a real subscription still gets the recurring signal
    assert _cat(_txn("-139.00", "KLUB SPORTOWY TEST"), subs={"KLUB SPORTOWY TEST"}) == (
        "subscriptions", "subscription")


def test_b2_loans_category_exists():
    cat = next(c for c in taxonomy.CATEGORIES if c.key == "loans")
    assert (cat.label, cat.kind) == ("Raty kredytów", "expense")


def test_b2_detect_recurring_only_lists_subscriptions(session):
    from cashu.modules.budget.analytics import detect_recurring

    _seed_recurring_mix(session)
    found = {(c.counterparty, c.currency, c.typical_amount) for c in detect_recurring(session)}
    assert found == {
        ("NETFLIX.COM", "PLN", Decimal("43.00")),
        ("KLUB SPORTOWY TEST", "PLN", Decimal("139.00")),
        ("SPOTIFY TEST", "EUR", Decimal("9.99")),
    }


def test_b2_categorize_all_keeps_installments_out_of_subscriptions(session):
    from sqlmodel import select

    from cashu.modules.budget.service import categorize_all

    _seed_recurring_mix(session)
    categorize_all(session)
    by_title = {t.reference: t.category for t in session.exec(select(Transaction)).all()}
    assert by_title["RATA KREDYTU HIPOTECZNEGO"] == "loans"
    assert by_title["SPŁATA KREDYTU"] == "loans"
    assert by_title["CZYNSZ"] == "housing"
    assert by_title["CZYNSZ ZA MIESZKANIE"] == "housing"
    assert by_title["KLUB SPORTOWY TEST"] == "subscriptions"
    assert by_title["NETFLIX.COM"] == "subscriptions"


def test_b2_manual_category_excludes_from_subscriptions(session):
    from sqlmodel import select

    from cashu.modules.budget.analytics import detect_recurring
    from cashu.modules.budget.service import set_transaction_category

    _seed_recurring_mix(session)
    for t in session.exec(select(Transaction).where(Transaction.reference == "KLUB SPORTOWY TEST")):
        set_transaction_category(session, t.id, "housing")
    assert "KLUB SPORTOWY TEST" not in {c.counterparty for c in detect_recurring(session)}


def test_b2_api_subscription_totals_per_currency(api):
    subs = api.get("/api/summary").json()["subscriptions"]
    # seed: Netflix 43 + sports club 139 (PLN) and Spotify 9.99 (EUR); rent, the
    # mortgage, the ATM withdrawal and the card fee are not subscriptions.
    assert subs == {"count": 3, "monthly_total": 182.0, "monthly_totals": {"EUR": 9.99, "PLN": 182.0}}
    items = api.get("/api/recurring").json()["items"]
    assert {(i["payee"], i["currency"], i["amount"], i["active"]) for i in items} == {
        ("NETFLIX.COM", "PLN", 43.0, True),
        ("KLUB SPORTOWY TEST", "PLN", 139.0, True),
        ("SPOTIFY TEST", "EUR", 9.99, True),
    }


# --------------------------------------------------------------------------- #
# B3 - Open Banking sync skips transactions booked later on the same day as the
#      newest stored one
# --------------------------------------------------------------------------- #

_OB_IBAN = "PL99114000000000000000000001"


def _ob_session(txns):
    return {"s1": {
        "aspsp": {"name": "mBank"},
        "accounts": [{"uid": "uid-1", "account_id": {"iban": _OB_IBAN}, "currency": "PLN"}],
        "transactions": {"uid-1": txns},
        "balances": {"uid-1": []},
    }}


def _sync(session, fake_eb, txns):
    from cashu.modules.budget.ingestion.enable_banking.sync import sync_session

    results = sync_session(session, fake_eb(_ob_session(txns)), "s1", bank="mbank")
    session.flush()
    return results


def _amounts(session):
    from sqlmodel import select

    return sorted((t.booking_date.isoformat(), str(t.amount))
                  for t in session.exec(select(Transaction)).all())


def test_b3_same_day_transaction_booked_after_a_sync_is_kept(session, fake_eb, make_eb_txn):
    morning = make_eb_txn("2026-09-20", "82.54", "LIDL TEST", ref="eb-a")
    _sync(session, fake_eb, [morning])
    # next sync: the same morning payment, one booked later that day, one next day
    evening = make_eb_txn("2026-09-20", "15.00", "ZABKA TEST", ref="eb-b")
    next_day = make_eb_txn("2026-09-21", "30.00", "ORLEN TEST", ref="eb-c")
    res = _sync(session, fake_eb, [morning, evening, next_day])
    assert res[0].batch.num_inserted == 2
    assert _amounts(session) == [
        ("2026-09-20", "-15.00"), ("2026-09-20", "-82.54"), ("2026-09-21", "-30.00"),
    ]


def test_b3_csv_boundary_day_is_not_duplicated(session, fake_eb, make_eb_txn):
    """CSV export taken mid-day: the CSV row and its Open Banking twin carry
    different memos, so the content hash cannot match; only the surplus counts."""
    from cashu.core.accounts import get_or_create_account
    from cashu.modules.budget.ingestion.normalize import RawTransaction
    from cashu.modules.budget.service import ingest_transactions

    acc = get_or_create_account(session, bank="mbank", iban=_OB_IBAN)
    ingest_transactions(session, acc, [RawTransaction(
        booking_date=date(2026, 9, 20), amount=Decimal("-82.54"),
        reference="LIDL TEST KRAKOW  DATA TRANSAKCJI: 2026-09-20", source=Source.CSV,
    )], source=Source.CSV)
    session.flush()
    twin = make_eb_txn("2026-09-20", "82.54", "VISA PLATNOSC KARTA 82.54 PLN LIDL TEST", ref="eb-a")
    later = make_eb_txn("2026-09-20", "15.00", "ZABKA TEST", ref="eb-b")
    _sync(session, fake_eb, [twin, later])
    assert _amounts(session) == [("2026-09-20", "-15.00"), ("2026-09-20", "-82.54")]


def test_b3_identical_same_day_payments_keep_their_count(session, fake_eb, make_eb_txn):
    coffee1 = make_eb_txn("2026-09-20", "12.50", "KAWIARNIA TEST", ref="eb-1")
    _sync(session, fake_eb, [coffee1])
    coffee2 = make_eb_txn("2026-09-20", "12.50", "KAWIARNIA TEST", ref="eb-2")
    _sync(session, fake_eb, [coffee1, coffee2])
    _sync(session, fake_eb, [coffee1, coffee2])  # idempotent
    assert _amounts(session) == [("2026-09-20", "-12.50"), ("2026-09-20", "-12.50")]


def test_b3_days_before_the_newest_stored_day_are_still_skipped(session, fake_eb, make_eb_txn):
    """The high-water mark itself stays: older Open Banking rows (already covered
    by a CSV backfill) are not re-ingested."""
    _sync(session, fake_eb, [make_eb_txn("2026-09-20", "82.54", "LIDL TEST", ref="eb-a")])
    _sync(session, fake_eb, [make_eb_txn("2026-09-19", "99.00", "STARY WPIS TEST", ref="eb-old")])
    assert _amounts(session) == [("2026-09-20", "-82.54")]


def test_b3_dedup_bank_id_match_consumes_its_content_slot(session):
    """Overlapping Open Banking windows re-send stored rows; a stored row matched
    by its bank id must not also swallow an identical new row (different id)."""
    from cashu.modules.budget.ingestion.dedup import prepare_new_transactions
    from cashu.modules.budget.ingestion.normalize import RawTransaction

    def coffee(btid):
        return RawTransaction(booking_date=date(2026, 9, 20), amount=Decimal("-12.50"),
                              reference="KAWIARNIA TEST", bank_transaction_id=btid,
                              source=Source.OPEN_BANKING)

    for t in prepare_new_transactions(session, 1, [coffee("eb-1")]).to_insert:
        session.add(t)
    session.flush()
    res = prepare_new_transactions(session, 1, [coffee("eb-1"), coffee("eb-2")])
    assert (res.num_inserted, res.num_duplicates) == (1, 1)
    assert res.to_insert[0].bank_transaction_id == "eb-2"
    assert res.to_insert[0].occurrence == 1


# --------------------------------------------------------------------------- #
# B5 - /api/resync holds one write transaction across all bank network calls
# --------------------------------------------------------------------------- #

def _write_lock_probe(db_path: str, failures: list[str]):
    """Return an `on_network` hook that checks, from a second connection, that
    the database can be written while the simulated bank request is in flight."""
    import sqlite3

    def probe(call: str) -> None:
        conn = sqlite3.connect(db_path, timeout=0.05)
        try:
            conn.execute("BEGIN IMMEDIATE")
            conn.rollback()
        except sqlite3.OperationalError as e:  # "database is locked"
            failures.append(f"{call}: {e}")
        finally:
            conn.close()

    return probe


def _two_bank_sessions(make_eb_txn):
    def acct(uid, iban, txns):
        return {
            "aspsp": {"name": "Bank Test"},
            "accounts": [{"uid": uid, "account_id": {"iban": iban}, "currency": "PLN"}],
            "transactions": {uid: txns},
            "balances": {uid: [{"balance_amount": {"amount": "100.00", "currency": "PLN"},
                                "balance_type": "CLBD", "reference_date": "2026-10-02"}]},
        }

    return {
        "sess-m": acct("uid-m", "PL99114000000000000000000001", [
            make_eb_txn("2026-10-01", "25.00", "BIEDRONKA 123 TEST", ref="m-1"),
            make_eb_txn("2026-10-02", "43.00", "NETFLIX.COM", ref="m-2"),
        ]),
        "sess-e": acct("uid-e", "PL99109000000000000000000003", [
            make_eb_txn("2026-10-01", "12.00", "KAWIARNIA TEST", ref="e-1"),
        ]),
    }


def test_b5_resync_does_not_hold_a_write_lock_during_bank_calls(
    api, seeded_engine, eb_configured, fake_eb, make_eb_txn,
):
    failures: list[str] = []
    client = fake_eb(_two_bank_sessions(make_eb_txn),
                     on_network=_write_lock_probe(seeded_engine.url.database, failures))
    eb_configured(client, {"mbank": "sess-m", "erste": "sess-e"})
    body = api.post("/api/resync").json()
    assert failures == []
    assert body == {
        "ok": True, "inserted": 3,
        "banks": [{"bank": "mbank", "inserted": 2, "accounts": 1},
                  {"bank": "erste", "inserted": 1, "accounts": 1}],
        "pairs": 0, "errors": [],
    }
    # every bank call happened before the first write
    assert client.calls == ["get_session", "iter_transactions", "get_account_balances"] * 2


def test_b5_one_failing_account_does_not_lose_the_others(
    api, seeded_engine, eb_configured, fake_eb, make_eb_txn,
):
    class Flaky(fake_eb):
        def get_account_balances(self, account_uid):
            if account_uid == "uid-e":
                raise RuntimeError("429 Too Many Requests")
            return super().get_account_balances(account_uid)

    eb_configured(Flaky(_two_bank_sessions(make_eb_txn)), {"mbank": "sess-m", "erste": "sess-e"})
    body = api.post("/api/resync").json()
    assert body["inserted"] == 2
    assert body["banks"] == [{"bank": "mbank", "inserted": 2, "accounts": 1},
                             {"bank": "erste", "inserted": 0, "accounts": 0}]
    assert body["errors"] == ["uid-e: 429 Too Many Requests"]
    # the failed account is skipped as a whole: what was reported is what is stored
    assert api.get("/api/category/dining/transactions", params={"month": 10}).json() == []
