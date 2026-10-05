from datetime import date
from decimal import Decimal

import pytest
from sqlmodel import Session, SQLModel, create_engine, select

from finanse import models  # noqa: F401  (register tables)


@pytest.fixture(autouse=True)
def _private_launch_agents_dir(tmp_path, monkeypatch):
    """The worker's launchd agents dir points into tmp_path for every test, so nothing
    (e.g. GET /api/system) ever reads or writes the real ~/Library/LaunchAgents."""
    monkeypatch.setenv("FINANSE_LAUNCH_AGENTS_DIR", str(tmp_path / "LaunchAgents"))
    # Never post through an installed Finanse.app (the notifier's "auto" choice).
    monkeypatch.setenv("FINANSE_APP_BUNDLE", "none")


@pytest.fixture(autouse=True)
def _private_workspaces_dir(tmp_path, monkeypatch):
    """Agent workspaces default into tmp_path for every test (core/workspace), never the real
    ~/Documents/finanse."""
    monkeypatch.setenv("FINANSE_WORKSPACES_DIR", str(tmp_path / "workspaces"))


@pytest.fixture
def session():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        yield s
    engine.dispose()


# --------------------------------------------------------------------------- #
# Synthetic seeded database (characterization tests for the API and the CLI).
#
# Everything here is invented: account numbers use a fake "99" prefix, names
# and merchants end in "TEST". The data is shaped like a small household:
# salary, rent, a mortgage installment, real subscriptions (one in EUR), bank
# fees, ATM withdrawals, groceries and fuel, savings transfers, a property, a
# mortgage with amortization terms, a car and a cash pool.
# --------------------------------------------------------------------------- #

IBAN_MAIN = "99114000000000000000000001"      # mBank PLN checking
IBAN_EUR = "99114000000000000000000002"       # mBank EUR checking
IBAN_SAVINGS = "99109000000000000000000003"   # Erste PLN savings
IBAN_EMPLOYER = "99102000000000000000000777"
IBAN_MORTGAGE_BANK = "99160000000000000000000555"
IBAN_WSPOLNOTA = "99105000000000000000000333"

SEED_YEAR = 2026
SEED_MONTHS = (6, 7, 8, 9)


def seed_demo(s: Session, profile_id: int | None = None) -> None:
    """Fill a profile (default: the default profile) through the project's own
    service layer. Seeding two profiles gives them the same account numbers."""
    from finanse.core import accounts
    from finanse.models import AccountType, Source, Transaction
    from finanse.modules.assets import service as assets
    from finanse.modules.budget import cash
    from finanse.modules.budget import service as budget
    from finanse.modules.budget.ingestion.normalize import RawTransaction
    from finanse.modules.budget.ingestion.transfers import match_internal_transfers
    from finanse.modules.loans import service as loans

    pid = profile_id
    main = accounts.get_or_create_account(
        s, bank="mbank", iban=IBAN_MAIN, name="mKonto Test", profile_id=pid
    )
    eur = accounts.get_or_create_account(
        s, bank="mbank", iban=IBAN_EUR, name="eKonto EUR Test", currency="EUR", profile_id=pid
    )
    sav = accounts.get_or_create_account(
        s, bank="erste", iban=IBAN_SAVINGS, name="Erste Test", type=AccountType.SAVINGS,
        profile_id=pid,
    )

    def raw(d, amount, *, ref=None, cp=None, iban=None, desc=None, currency="PLN"):
        return RawTransaction(
            booking_date=d, amount=Decimal(amount), currency=currency,
            counterparty_name=cp, counterparty_iban=iban, description=desc,
            reference=ref, source=Source.CSV,
        )

    main_rows: list[RawTransaction] = []
    eur_rows: list[RawTransaction] = [
        raw(date(SEED_YEAR, 6, 1), "500.00", ref="ZASILENIE", currency="EUR"),
    ]
    sav_rows: list[RawTransaction] = []
    for m in SEED_MONTHS:
        def d(day: int, m: int = m) -> date:
            return date(SEED_YEAR, m, day)

        main_rows += [
            # real subscription without a seed rule -> recurring signal
            raw(d(2), "-139.00", ref="KLUB SPORTOWY TEST", desc="ZAKUP PRZY UZYCIU KARTY"),
            raw(d(3), "-650.00", ref="CZYNSZ", cp="WSPOLNOTA MIESZKANIOWA TEST",
                iban=IBAN_WSPOLNOTA, desc="PRZELEW WYCHODZACY"),
            raw(d(5), "-3000.00", ref="RATA KREDYTU HIPOTECZNEGO", cp="BANK HIPOTECZNY TEST",
                iban=IBAN_MORTGAGE_BANK, desc="PRZELEW WYCHODZACY"),
            raw(d(6), f"-{100 + m}.50", ref="BIEDRONKA 123 TEST", desc="ZAKUP PRZY UZYCIU KARTY"),
            raw(d(7), "-43.00", ref="NETFLIX.COM", desc="ZAKUP PRZY UZYCIU KARTY"),
            raw(d(10), "9000.00", ref=f"WYNAGRODZENIE ZA {m - 1:02d}/{SEED_YEAR}",
                iban=IBAN_EMPLOYER, desc="PRZELEW PRZYCHODZACY"),
            raw(d(11), "-1000.00", ref="OSZCZEDNOSCI", cp="Erste Test", iban=IBAN_SAVINGS,
                desc="PRZELEW WYCHODZACY"),
            raw(d(15), "-300.00", ref="WYPLATA W BANKOMACIE TEST", desc="WYPLATA W BANKOMACIE"),
            raw(d(20), f"-{60 + 2 * m}.25", ref="BIEDRONKA 123 TEST", desc="ZAKUP PRZY UZYCIU KARTY"),
            raw(d(21), f"-{200 + m}.00", ref="ORLEN STACJA TEST", desc="ZAKUP PRZY UZYCIU KARTY"),
            raw(d(28), "-7.00", ref="OPLATA ZA KARTE", desc="OPLATA"),
        ]
        eur_rows.append(raw(d(14), "-9.99", ref="SPOTIFY TEST", currency="EUR"))
        sav_rows.append(raw(d(11), "1000.00", ref="OSZCZEDNOSCI", cp="mKonto Test", iban=IBAN_MAIN))
    # one merchant no rule knows -> "other"/default (feeds /api/uncategorized)
    main_rows.append(raw(date(SEED_YEAR, 8, 25), "-55.00", ref="SKLEP NIEZNANY TEST"))

    budget.ingest_transactions(s, main, main_rows, source=Source.CSV)
    budget.ingest_transactions(s, eur, eur_rows, source=Source.CSV)
    budget.ingest_transactions(s, sav, sav_rows, source=Source.CSV)

    end = date(SEED_YEAR, 9, 30)
    accounts.upsert_balance(s, main, end, Decimal("5000.00"), source=Source.CSV)
    accounts.upsert_balance(s, eur, end, Decimal("460.04"), source=Source.CSV)
    accounts.upsert_balance(s, sav, end, Decimal("24000.00"), source=Source.CSV)

    assets.add_manual_position(
        s, name="Mieszkanie Test", type=AccountType.PROPERTY, value="600000",
        on_date=date(SEED_YEAR, 6, 1), profile_id=pid,
    )
    mortgage = assets.add_manual_position(
        s, name="Kredyt hipoteczny Test", type=AccountType.MORTGAGE, value="390000",
        on_date=date(SEED_YEAR, 6, 1), profile_id=pid,
    )
    loans.set_loan(
        s, mortgage.id, "400000", "6.0", 300, date(2025, 1, 5),
        origination_date=date(2024, 12, 10), profile_id=pid,
    )
    assets.set_vehicle(
        s, name="Auto Test", purchase_price="80000", purchase_date=date(2025, 5, 1),
        annual_rate="15", floor="10000", profile_id=pid,
    )
    s.flush()

    match_internal_transfers(s, profile_id=pid)
    budget.categorize_all(s, profile_id=pid)

    # Move the September ATM withdrawal into the cash pool and log one cash spend.
    atm = s.exec(
        select(Transaction).where(
            Transaction.account_id == main.id,
            Transaction.reference == "WYPLATA W BANKOMACIE TEST",
            Transaction.booking_date == date(SEED_YEAR, 9, 15),
        )
    ).one()
    budget.set_transaction_category(s, atm.id, "cash_withdrawal", profile_id=pid)
    cash.add_cash_expense(
        s, amount="40.00", title="Targ Test", category="groceries",
        on_date=date(SEED_YEAR, 9, 16), profile_id=pid,
    )


def use_engine(monkeypatch, engine) -> None:
    """Point the app-wide engine (read at call time by get_session / init_db, so
    used by the API and the CLI) at `engine`."""
    from finanse import db

    monkeypatch.setattr(db, "engine", engine)


@pytest.fixture
def db_engine(tmp_path, monkeypatch):
    """An empty, file-backed SQLite DB wired in as the application database.

    File-backed (not in-memory) so the API's own sessions, the CLI and extra raw
    connections all see the same data. FINANSE_DATA_DIR points into tmp_path so
    nothing touches a real data directory.
    """
    from finanse import db

    monkeypatch.setenv("FINANSE_DATA_DIR", str(tmp_path / "data"))
    engine = create_engine(f"sqlite:///{tmp_path / 'finanse.db'}")
    use_engine(monkeypatch, engine)
    db.init_db()
    yield engine
    engine.dispose()


@pytest.fixture
def seeded_engine(db_engine):
    from finanse.db import get_session

    with get_session() as s:
        seed_demo(s)
    return db_engine


def make_client(app):
    """TestClient that satisfies the local-API security layer when it is present
    (token header + allowed Host); plain TestClient on the upstream app."""
    from fastapi.testclient import TestClient

    try:
        from finanse.core import security
    except ImportError:  # upstream app without the security layer
        return TestClient(app)
    cfg = security.get_config()
    return TestClient(app, base_url=cfg.base_url, headers={security.TOKEN_HEADER: cfg.token})


@pytest.fixture
def api(seeded_engine):
    """TestClient over the FastAPI app, backed by the seeded synthetic DB."""
    from finanse.api.app import app

    with make_client(app) as client:
        yield client


@pytest.fixture
def api_empty(db_engine):
    """TestClient over the FastAPI app with an empty DB."""
    from finanse.api.app import app

    with make_client(app) as client:
        yield client


# --------------------------------------------------------------------------- #
# Enable Banking stand-in (no network).
# --------------------------------------------------------------------------- #

class FakeEBClient:
    """Duck-typed EnableBankingClient with canned data.

    `sessions` maps session_id -> {"aspsp": {...}, "accounts": [<account obj>],
    "transactions": {uid: [<EB txn>]}, "balances": {uid: [<EB balance>]}}.
    `on_network(method_name)` runs before every simulated network call (tests use
    it to probe the DB while the "request" is in flight).
    """

    def __init__(self, sessions: dict, on_network=None):
        self.sessions = sessions
        self.on_network = on_network
        self.calls: list[str] = []

    def _net(self, name: str) -> None:
        self.calls.append(name)
        if self.on_network is not None:
            self.on_network(name)

    def _find(self, uid: str) -> dict:
        return next(s for s in self.sessions.values() if uid in s.get("transactions", {}))

    def get_session(self, session_id: str) -> dict:
        self._net("get_session")
        s = self.sessions[session_id]
        return {"aspsp": s.get("aspsp", {}), "accounts": s.get("accounts", [])}

    def get_account_details(self, account_uid: str) -> dict:
        self._net("get_account_details")
        return self._find(account_uid).get("details", {}).get(account_uid, {})

    def iter_transactions(self, account_uid: str, *, date_from=None, date_to=None):
        self._net("iter_transactions")
        yield from self._find(account_uid)["transactions"][account_uid]

    def get_account_balances(self, account_uid: str) -> list:
        self._net("get_account_balances")
        return self._find(account_uid).get("balances", {}).get(account_uid, [])


def eb_txn(day: str, amount: str, title: str, *, ref: str, debit: bool = True,
           currency: str = "PLN") -> dict:
    """A minimal Enable Banking transaction object (synthetic)."""
    return {
        "entry_reference": ref,
        "transaction_amount": {"currency": currency, "amount": amount},
        "credit_debit_indicator": "DBIT" if debit else "CRDT",
        "booking_date": day,
        "remittance_information": [title],
    }


@pytest.fixture
def fake_eb():
    return FakeEBClient


@pytest.fixture
def make_eb_txn():
    return eb_txn


@pytest.fixture
def eb_configured(monkeypatch):
    """Make the app believe Enable Banking is configured and hand it `client`
    plus the saved `sessions` ({institution id: session id}) of the profile in use."""
    from finanse.config import settings

    monkeypatch.setattr(type(settings), "eb_configured", property(lambda self: True))

    def install(client, sessions: dict[str, str]):
        import importlib

        from finanse.modules.budget.ingestion.enable_banking import state

        budget_api = importlib.import_module("finanse.modules.budget.api")

        monkeypatch.setattr(budget_api, "_eb_client", lambda: client)
        saved = [state.SavedSession(bank, sid) for bank, sid in sessions.items()]
        monkeypatch.setattr(state, "load_sessions", lambda *_a, **_k: list(saved))
        return client

    return install
