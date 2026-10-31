#!/usr/bin/env python3
"""Synthetic parity vectors for the TypeScript budget transfers and cash port (scope S08).

    .venv/bin/python parity/python/vectors_budget_transfers.py            # writes the vectors
    .venv/bin/python parity/python/vectors_budget_transfers.py --check    # regenerates in memory, fails on any diff

Writes ``packages/domain/test/vectors/budget-transfers.jsonl``, ``budget-transfer-keys.jsonl``,
``budget-cash.jsonl`` and ``budget-cash-matching-data.jsonl``. Every input is synthetic (random with a
fixed seed plus hand-picked edge cases). Nothing reads a data dir: the scenarios run the real
``match_internal_transfers`` / ``sync_cash_leg`` / ``add_cash_expense`` / ``CashContributor`` on one
in-memory SQLite engine built with ``SQLModel.metadata.create_all`` (every module's models, so the
real index set exists and SQLite picks the real query plan), each scenario rolled back.

File format as ``vectors.py``: JSON Lines, line 1 ``{"meta": {...}}``, then one JSON array per vector
(layout in ``meta.layout``). Errors are ``{"error": "<class>"}``.
"""

from __future__ import annotations

import argparse
import ast
import contextlib
import datetime as dt
import hashlib
import inspect
import json
import random
import sys
import textwrap
import types
import unicodedata
from collections.abc import Iterable, Iterator
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

from sqlmodel import Session, SQLModel, create_engine, select

import cashu.models  # noqa: F401  (registers every table for create_all)
from cashu.core.accounts import profile_accounts
from cashu.core.models import Account, AccountType, Profile, Source
from cashu.modules.budget import cash as cash_mod
from cashu.modules.budget.cash import add_cash_expense, sync_cash_leg
from cashu.modules.budget.ingestion import transfers as transfers_mod
from cashu.modules.budget.ingestion.transfers import (
    match_internal_transfers,
    reset_transfer_matches,
)
from cashu.modules.budget.models import Transaction
from cashu.modules.budget.networth import CashContributor
from cashu.modules.budget.queries import transactions as txn_query

SEED = 20261101
OUT = ROOT / "packages" / "domain" / "test" / "vectors"
PROFILE, OTHER_PROFILE = 1, 2
BASE_DAY = dt.date(2026, 3, 10)

if sys.version_info < (3, 14):
    raise SystemExit("vectors_budget_transfers.py needs Python 3.14+ (decimal behaviour is pinned)")


def error_name(exc: BaseException) -> str:
    return type(exc).__name__


def make_engine():
    engine = create_engine("sqlite://")
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        s.add(Profile(id=PROFILE, slug="test-a", name="Test A"))
        s.add(Profile(id=OTHER_PROFILE, slug="test-b", name="Test B"))
        s.commit()
    return engine


@contextlib.contextmanager
def sequential_group_ids() -> Iterator[None]:
    """``transfers.uuid4`` replaced by a counter: the group ids sort in creation order (pair order)."""
    counter = {"n": 0}

    def seq() -> types.SimpleNamespace:
        counter["n"] += 1
        return types.SimpleNamespace(hex=f"{counter['n']:032x}")

    original = transfers_mod.uuid4
    transfers_mod.uuid4 = seq
    try:
        yield
    finally:
        transfers_mod.uuid4 = original


# --------------------------------------------------------------------------- amounts and IBANs

# Magnitudes that force amount-key collisions and pin the two roundings of the key (Q4 / Q5): the
# inflow key formats the exact value, the outflow key formats ``-x`` (context-rounded to 28 digits).
MAGNITUDES = (
    "100.00", "100", "100.0", "1E+2", "250.50", "250.5", "7.10", "7.1", "12.345", "12.355",
    "0.004", "0.001", "0.005", "0.015", "0.0049", "1.015", "1.02", "1.01",
    "1.014999999999999999999999999999",   # 31 significant digits: inflow "1.01", outflow "1.02"
    "1.0149999999999999999999999999",     # 29
    "1.01499999999999999999999999999",    # 30
    "1.025000000000000000000000000001",
    "99999999999999999999999999.995",
    "5E-3", "1.5E+1", "15",
)
ZEROS = ("0", "-0", "0.00", "-0.00", "0E-5")


def amount_text(rng: random.Random, mags: list[str], sign: int) -> str:
    if rng.random() < 0.04:
        return rng.choice(ZEROS)
    mag = rng.choice(mags)
    return f"-{mag}" if sign < 0 else mag


def nrb(rng: random.Random) -> str:
    """A synthetic 26-digit account number (``99`` prefix like the tests; mod-97 almost never holds)."""
    return "99" + "".join(rng.choice("0123456789") for _ in range(24))


def iban_form(rng: random.Random, number: str) -> str:
    """One of the forms a bank export or Open Banking writes the same account number in."""
    k = rng.randrange(7)
    if k == 0:
        return number
    if k == 1:
        return "PL" + number
    if k == 2:
        s = "PL" + number
        return " ".join(s[i:i + 4] for i in range(0, len(s), 4))
    if k == 3:
        return "'" + number
    if k == 4:
        return "pl" + number
    if k == 5:
        return "PL-" + "-".join(number[i:i + 4] for i in range(0, len(number), 4))
    return " " + number[:2] + " " + number[2:] + " "


GARBAGE_IBANS = ("", "'", "PL", "XX", "abc", "  ", "0", "PL00 0000", "DE89370400440532013000", "AB")


# --------------------------------------------------------------------------- transfer scenarios


def plan_detail(s: Session, engine) -> str:
    """EXPLAIN QUERY PLAN of the ungrouped-rows query ``match_internal_transfers`` runs (no data)."""
    stmt = txn_query(PROFILE, Transaction.transfer_group_id.is_(None))  # type: ignore[union-attr]
    compiled = stmt.compile(dialect=engine.dialect)
    params = compiled.construct_params()
    args = tuple(params[k] for k in compiled.positiontup)
    rows = s.connection().exec_driver_sql("EXPLAIN QUERY PLAN " + str(compiled), args).all()
    return " | ".join(r[3] for r in rows)


def add_txn(s: Session, tid: int, account_id: int, day: dt.date, amount: str, cp: str | None) -> None:
    s.add(Transaction(
        id=tid, account_id=account_id, booking_date=day, amount=Decimal(amount), currency="PLN",
        counterparty_name="TEST", counterparty_iban=cp, description="PRZELEW TEST",
        source=Source.CSV, dedup_hash=f"t{tid}", occurrence=0,
    ))


def transfer_scenario(rng: random.Random, s: Session) -> list:
    numbers = [nrb(rng) for _ in range(6)]
    n_acc = rng.randint(2, 5)
    acc_ids = rng.sample(range(1, 40), n_acc + 1)
    own: list[tuple[int, str | None]] = []
    for i in range(n_acc):
        number = numbers[i] if rng.random() > 0.1 or i == 0 else numbers[i - 1]  # 10%: a shared number
        r = rng.random()
        iban = None if r < 0.12 else rng.choice(GARBAGE_IBANS) if r < 0.17 else iban_form(rng, number)
        s.add(Account(
            id=acc_ids[i], bank=rng.choice(("mbank", "erste", "pekao")), name="Konto Test",
            iban=iban, external_id=f"x:{acc_ids[i]}", currency=rng.choice(("PLN", "PLN", "EUR")),
            type=rng.choice(("checking", "savings")), profile_id=PROFILE,
            removed_at=dt.datetime(2026, 1, 1, tzinfo=dt.UTC) if rng.random() < 0.15 else None,
        ))
        own.append((acc_ids[i], iban))
    other = None
    if rng.random() < 0.15:  # an account of another profile: never a candidate, never "own"
        other = (acc_ids[n_acc], iban_form(rng, numbers[5]))
        s.add(Account(id=other[0], bank="erste", name="Konto Test", iban=other[1],
                      external_id=f"x:{other[0]}", profile_id=OTHER_PROFILE))
    s.flush()

    def cp_iban(row_account: int) -> str | None:
        r = rng.random()
        if r < 0.3:
            return None
        if r < 0.7:
            idx = rng.randrange(n_acc)
            number = numbers[idx] if own[idx][1] is not None else numbers[rng.randrange(n_acc)]
            return iban_form(rng, number)
        if r < 0.78 and other is not None:
            return iban_form(rng, numbers[5])
        if r < 0.88:
            return iban_form(rng, numbers[4])  # a third party's number
        return rng.choice(GARBAGE_IBANS)

    mags = rng.sample(MAGNITUDES, rng.randint(1, 5))
    n_rows = rng.choice((0, rng.randint(1, 8), rng.randint(2, 30), rng.randint(20, 60)))
    ids = rng.sample(range(100, 100 + 3 * max(n_rows, 1)), n_rows)  # shuffled id order
    i = 0
    while i < n_rows:
        a, b = rng.sample([x for x, _ in own], 2)
        if i + 1 < n_rows and rng.random() < 0.6:  # a transfer-shaped pair
            mag = rng.choice(mags)
            day = BASE_DAY + dt.timedelta(days=rng.randint(-6, 6))
            add_txn(s, ids[i], a, day, f"-{mag}", cp_iban(a))
            add_txn(s, ids[i + 1], b, day + dt.timedelta(days=rng.choice((0, 0, 1, 2, 3, 4, -1, -3, -4))),
                    mag, cp_iban(b))
            i += 2
        else:
            add_txn(s, ids[i], a, BASE_DAY + dt.timedelta(days=rng.randint(-6, 6)),
                    amount_text(rng, mags, rng.choice((-1, 1))), cp_iban(a))
            i += 1
    if other is not None:
        for k in range(rng.randint(0, 3)):
            add_txn(s, 900 + k, other[0], BASE_DAY, rng.choice(("100.00", "-100.00")), iban_form(rng, numbers[0]))
    s.flush()

    if rng.random() < 0.12:  # cash pool, legs and cash expenses: candidates that never score (Q8)
        s.get(Profile, PROFILE).base_currency = rng.choice(("PLN", "EUR"))
        bank_rows = [t for t in s.exec(txn_query(PROFILE)).all() if t.amount < 0]
        for t in rng.sample(bank_rows, min(len(bank_rows), rng.randint(0, 2))):
            sync_cash_leg(s, t, "cash_withdrawal")
        for _ in range(rng.randint(0, 2)):
            add_cash_expense(s, amount=rng.choice(mags), title="TEST", category="dining",
                             on_date=BASE_DAY, profile_id=PROFILE)
        s.flush()

    stale = rng.random() < 0.1  # stale groups first: reset + match must equal a fresh match
    if stale:
        for t in s.exec(txn_query(PROFILE)).all():
            if rng.random() < 0.4:
                t.transfer_group_id = f"stale{rng.randrange(3)}"
                t.is_internal_transfer = True
        s.flush()
        reset_transfer_matches(s, profile_id=PROFILE)
        s.flush()
    with sequential_group_ids():
        n = match_internal_transfers(s, profile_id=PROFILE)
    s.flush()

    rows = s.exec(txn_query(PROFILE).order_by(Transaction.id)).all()
    groups: dict[str, list[Transaction]] = {}
    for t in rows:
        if t.transfer_group_id is not None:
            groups.setdefault(t.transfer_group_id, []).append(t)
    pairs = []
    for gid in sorted(groups):
        legs = groups[gid]
        out = [t.id for t in legs if t.amount < 0]
        inc = [t.id for t in legs if t.amount > 0]
        assert len(legs) == 2 and len(out) == 1 and len(inc) == 1, "a group is one outflow + one inflow"
        pairs.append([out[0], inc[0]])
    assert len(pairs) == n
    accounts = [[a.id, a.iban] for a in sorted(profile_accounts(s, PROFILE), key=lambda a: a.id)]
    out_rows = [[t.id, t.account_id, t.booking_date.isoformat(), str(t.amount), t.counterparty_iban]
                for t in rows]
    return [stale, accounts, out_rows, pairs]


FIXED_SCENARIOS = 1500


def gen_transfers(rng: random.Random) -> list:
    engine = make_engine()
    out: list = []
    plan = None
    for _ in range(FIXED_SCENARIOS):
        with Session(engine) as s:
            try:
                scenario = transfer_scenario(rng, s)
                detail = plan_detail(s, engine)
            finally:
                s.rollback()
        if plan is None:
            plan = detail
        assert detail == plan, "the ungrouped query's plan changed between scenarios"
        out.append(["scenario", *scenario])
    engine.dispose()
    return [["plan", plan], *out]


# --------------------------------------------------------------------------- amount keys


def transfer_key(x: Decimal) -> str | None:
    """transfers.py:84 / 97: inflow ``f"{x:.2f}"``, outflow ``f"{-x:.2f}"``, zero never keyed."""
    if x > 0:
        return f"{x:.2f}"
    if x < 0:
        return f"{-x:.2f}"
    return None


KEY_EDGES = (
    "0", "-0", "0.00", "-0.00", "0E-30", "-0E+5", "1E+1", "-1E+1", "1E-2", "5E-3", "-5E-3",
    "0.004", "-0.004", "0.005", "-0.005", "0.015", "-0.015", "0.025", "-0.025", "-0.001",
    "1.014999999999999999999999999999", "-1.014999999999999999999999999999",
    "1.0149999999999999999999999999", "-1.0149999999999999999999999999",
    "-1.01499999999999999999999999999", "-9999999999999999999999999999.995",
    "-99999999999999999999999999.995", "123456789012345678901234567.891",
    "-123456789012345678901234567.891", "1E+30", "-1E+30", "-1.5E-40", "100", "-100.00",
)


def gen_transfer_keys(rng: random.Random) -> list:
    rows = [["key", e, transfer_key(Decimal(e))] for e in KEY_EDGES]
    while len(rows) < 3000:
        n = rng.choice((1, 2, 3, 4, 8, 15, 27, 28, 29, 30, 31, 34))
        digits = "".join(rng.choice("0123456789") for _ in range(n))
        if rng.random() < 0.3:  # a half-way digit at the cent boundary
            digits = digits[: max(n - 3, 0)] + "5" + "0" * rng.randint(0, 2) + rng.choice(("", "1"))
        exp = rng.choice((-2, -3, -4, rng.randint(-35, 3)))
        x = Decimal((rng.randrange(2), tuple(int(c) for c in digits), exp))
        rows.append(["key", str(x), transfer_key(x)])
    return rows


# --------------------------------------------------------------------------- cash


def leg_case(rng: random.Random, s: Session) -> list:
    base = rng.choice(("PLN", "EUR", ""))
    s.get(Profile, PROFILE).base_currency = base
    currency = rng.choice(("PLN", "PLN", "EUR", "USD"))
    s.add(Account(id=1, bank="mbank", name="Konto Test", iban=None, external_id="x:1",
                  currency=currency, profile_id=PROFILE))
    s.flush()
    tid = rng.randint(1, 10_000)
    amount = rng.choice((
        "-200.00", "-200", "-1E+2", "-0", "0", "-12.345", "-1.014999999999999999999999999999",
        "-99999999999999999999999999999.5", "150.00", "-0.001",
    ))
    texts = (None, "", " ", "WYPLATA TEST", "Wypłata TEST")
    source = {
        "booking_date": (BASE_DAY + dt.timedelta(days=rng.randint(-30, 30))).isoformat(),
        "value_date": None if rng.random() < 0.4 else (BASE_DAY + dt.timedelta(days=rng.randint(0, 3))).isoformat(),
        "amount": amount,
        "currency": currency,
        "description": rng.choice(texts),
        "reference": rng.choice(texts),
    }
    bank = Transaction(
        id=tid, account_id=1, booking_date=dt.date.fromisoformat(source["booking_date"]),
        value_date=None if source["value_date"] is None else dt.date.fromisoformat(source["value_date"]),
        amount=Decimal(amount), currency=currency, description=source["description"],
        reference=source["reference"], source=Source.CSV, dedup_hash="b", occurrence=0,
    )
    s.add(bank)
    s.flush()
    sync_cash_leg(s, bank, "cash_withdrawal")
    s.flush()
    leg = s.exec(select(Transaction).where(Transaction.dedup_hash == f"cashleg:{tid}")).one()
    pool = s.get(Account, leg.account_id)
    return ["leg", base, tid, source, {
        "pool": [pool.bank, pool.name, pool.external_id, pool.type, pool.currency],
        "booking_date": leg.booking_date.isoformat(),
        "value_date": None if leg.value_date is None else leg.value_date.isoformat(),
        "amount": str(leg.amount),
        "currency": leg.currency,
        "counterparty_name": leg.counterparty_name,
        "description": leg.description,
        "reference": leg.reference,
        "source": leg.source.value,
        "dedup_hash": leg.dedup_hash,
        "category": leg.category,
        "category_source": leg.category_source,
        "raw": leg.raw,
    }]


EXPENSE_INPUTS: tuple = (
    "50", "-50", "0", "-0", "0.00", "-0.00", "1E+2", "12.345", "-12.345", " 7.5 ", "abc", "", "1,5",
    "1.014999999999999999999999999999", "99999999999999999999999999999.5", "0E-9",
    50, 0, -3, 50.0, 0.1, -0.0, 0.0, 1e-7, 1e20, 0.1 + 0.2, 123.456, -1.5,
    # Non-finite: Python stores a NaN / -Infinity expense; the TS Decimal refuses them (FIX(Q14)).
    "NaN", "Infinity", "-Infinity", "sNaN", float("nan"), float("inf"),
)


def expense_case(value: object, s: Session) -> list:
    text = str(value)
    try:
        txn = add_cash_expense(s, amount=value, title="TEST", category="dining",
                               on_date=BASE_DAY, profile_id=PROFILE)
        outcome: object = str(txn.amount)
    except Exception as exc:  # noqa: BLE001 - the vector records the error class
        outcome = {"error": error_name(exc)}
    return ["expense", type(value).__name__, text, outcome]


def pool_name_case(currency: str | None, base: str, s: Session) -> list:
    s.get(Profile, PROFILE).base_currency = base
    acc = cash_mod.get_cash_account(s, currency, create=True, profile_id=PROFILE)
    return ["pool", currency, base, [acc.bank, acc.name, acc.external_id, acc.type, acc.currency]]


def contributor_case(rng: random.Random, s: Session) -> list:
    cash_ids = rng.sample(range(1, 20), rng.randint(1, 2))
    s.add(Account(id=50, bank="mbank", name="Konto Test", external_id="x:50", profile_id=PROFILE))
    for cid in cash_ids:
        s.add(Account(id=cid, bank="manual", name="Gotówka", external_id=f"cash:{cid}",
                      type=AccountType.CASH, profile_id=PROFILE))
    s.flush()
    n = rng.randint(0, 25)
    rows = []
    for tid in rng.sample(range(1, 200), n):
        aid = rng.choice([*cash_ids, 50])
        day = BASE_DAY + dt.timedelta(days=rng.randint(0, 6))
        amount = rng.choice(("200.00", "-50", "-12.345", "0.1", "1E+1", "-0", "7",
                             "1.014999999999999999999999999999", "-3.33"))
        s.add(Transaction(id=tid, account_id=aid, booking_date=day, amount=Decimal(amount),
                          source=Source.MANUAL, dedup_hash=f"c{tid}", occurrence=0))
        rows.append([tid, aid, day.isoformat(), amount])
    s.flush()
    accounts = {a.id: a for a in profile_accounts(s, PROFILE)}
    valued = CashContributor().valuations(s, accounts)
    out = {str(aid): [[d.isoformat(), str(v)] for d, v in v_._points] for aid, v_ in valued.items()}
    return ["contributor", [[a.id, a.type] for a in accounts.values()], sorted(rows), out]


def gen_cash(rng: random.Random) -> list:
    engine = make_engine()
    rows: list = []

    def run(fn) -> None:
        with Session(engine) as s:
            try:
                rows.append(fn(s))
            finally:
                s.rollback()

    for _ in range(200):
        run(lambda s: leg_case(rng, s))
    for value in EXPENSE_INPUTS:
        run(lambda s, v=value: expense_case(v, s))
    while len(rows) < 400:
        if rng.random() < 0.6:
            digits = tuple(rng.randrange(10) for _ in range(rng.randint(1, 31)))
            value: object = str(Decimal((rng.randrange(2), digits, rng.randint(-8, 2))))
        else:
            value = rng.randint(-10_000, 10_000) / rng.choice((1, 10, 100, 1000))
        run(lambda s, v=value: expense_case(v, s))
    for currency in (None, "", "PLN", "EUR", "USD", "pln"):
        for base in ("PLN", "EUR", "", "USD"):
            run(lambda s, c=currency, b=base: pool_name_case(c, b, s))
    while len(rows) < 600:
        run(lambda s: contributor_case(rng, s))
    engine.dispose()
    return rows


# --------------------------------------------------------------------------- matching data


def _calls(fn, name: str) -> list[ast.Call]:
    tree = ast.parse(textwrap.dedent(inspect.getsource(fn)))
    return [n for n in ast.walk(tree) if isinstance(n, ast.Call) and getattr(n.func, "id", None) == name]


def _kw(call: ast.Call, name: str) -> ast.expr:
    return next(k.value for k in call.keywords if k.arg == name)


def _const(node: ast.expr) -> str:
    assert isinstance(node, ast.Constant) and isinstance(node.value, str), ast.dump(node)
    return node.value


def _fstring_parts(node: ast.expr) -> list[str]:
    """The literal parts of an f-string, a formatted value as ``{}``."""
    assert isinstance(node, ast.JoinedStr), ast.dump(node)
    return [v.value if isinstance(v, ast.Constant) else "{}" for v in node.values]


def _assigned(fn, target: str) -> ast.expr:
    tree = ast.parse(textwrap.dedent(inspect.getsource(fn)))
    return next(n.value for n in ast.walk(tree)
                if isinstance(n, ast.Assign) and getattr(n.targets[0], "id", None) == target)


def matching_data() -> dict:
    """The cash literals read from the LIVE Python source (never retyped)."""
    pool = _calls(cash_mod.get_cash_account, "Account")[0]
    name = _kw(pool, "name")
    assert isinstance(name, ast.IfExp)
    leg = _calls(cash_mod.sync_cash_leg, "Transaction")[0]
    description = _kw(leg, "description")
    assert isinstance(description, ast.BoolOp)
    compare = next(n for n in ast.walk(ast.parse(textwrap.dedent(inspect.getsource(cash_mod.sync_cash_leg))))
                   if isinstance(n, ast.Compare))
    expense = _calls(cash_mod.add_cash_expense, "Transaction")[0]
    return {
        "cash_account_type": AccountType.CASH.value,
        "pool_external_id": _fstring_parts(_assigned(cash_mod.get_cash_account, "ext")),
        "pool_name_base": _const(name.body),
        "pool_name_other": _fstring_parts(name.orelse),
        "leg_withdrawal_category": _const(compare.comparators[0]),
        "leg_dedup_hash": _fstring_parts(_assigned(cash_mod.sync_cash_leg, "tag")),
        "leg_counterparty_name": _const(_kw(leg, "counterparty_name")),
        "leg_description_fallback": _const(description.values[-1]),
        "leg_reference": _const(_kw(leg, "reference")),
        "leg_category": _const(_kw(leg, "category")),
        "leg_category_source": _const(_kw(leg, "category_source")),
        "expense_dedup_hash": _fstring_parts(_kw(expense, "dedup_hash")),
        "expense_category_source": _const(_kw(expense, "category_source")),
    }


def gen_matching_data(_rng: random.Random) -> list:
    """One row: the literals and the sha256 of their canonical serialisation (sorted keys, compact)."""
    obj = matching_data()
    text = json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return [["matching", obj, hashlib.sha256(text.encode("utf-8")).hexdigest()]]


# --------------------------------------------------------------------------- output

GENERATORS = {
    "budget-transfers": (gen_transfers, ("[\"plan\", detail] once, then [\"scenario\", stale_groups_reset, "
                         "accounts [[id, iban]], rows [[id, account_id, booking_date, amount, counterparty_iban]] "
                         "in id order, pairs [[out_id, in_id]] in creation order]")),
    "budget-transfer-keys": (gen_transfer_keys, "[\"key\", str(amount), key | null]"),
    "budget-cash": (gen_cash, ("[\"leg\", base, bank_id, source, leg] | [\"expense\", input_type, str(input), "
                    "amount | {error}] | [\"pool\", currency | null, base, [bank, name, external_id, type, "
                    "currency]] | [\"contributor\", accounts [[id, type]], txns [[id, account_id, date, amount]], "
                    "{account_id: [[date, value]]}]")),
    "budget-cash-matching-data": (gen_matching_data, "[\"matching\", literals, sha256]"),
}


def render_rows(name: str, layout: str, rows: list) -> str:
    meta = {"meta": {"name": name, "count": len(rows), "layout": layout, "seed": SEED,
                     "generator": "parity/python/vectors_budget_transfers.py",
                     "python": sys.version.split()[0], "unicode": unicodedata.unidata_version}}
    lines = [json.dumps(meta, ensure_ascii=False)]
    lines += [json.dumps(row, ensure_ascii=False, separators=(",", ":")) for row in rows]
    return "\n".join(lines) + "\n"


def outputs() -> dict[Path, bytes]:
    out: dict[Path, bytes] = {}
    for name, (fn, layout) in GENERATORS.items():
        rows = fn(random.Random(f"{SEED}:{name}"))
        out[OUT / f"{name}.jsonl"] = render_rows(name, layout, rows).encode("utf-8")
    return out


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="fail when a committed file differs")
    args = parser.parse_args(list(argv) if argv is not None else None)
    files = outputs()
    stale = []
    for path, content in files.items():
        if args.check:
            if not path.exists() or path.read_bytes() != content:
                stale.append(str(path.relative_to(ROOT)))
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
    if args.check:
        if stale:
            print("stale files: " + ", ".join(sorted(stale)))
            return 1
        print(f"{len(files)} files up to date")
        return 0
    print(f"{len(files)} files written")
    return 0


if __name__ == "__main__":
    sys.exit(main())
