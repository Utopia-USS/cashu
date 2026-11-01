#!/usr/bin/env python3
"""Synthetic parity vectors for the TypeScript budget categorization port (scope S09).

    .venv/bin/python parity/python/vectors_budget_categorize.py            # writes the vectors
    .venv/bin/python parity/python/vectors_budget_categorize.py --check    # regenerates in memory, fails on any diff

Writes ``packages/domain/test/vectors/budget-categorize-*.jsonl`` and
``budget-categorize-matching-data.jsonl``. Every input is synthetic: random with a fixed seed, the
live Python rule tables (imported, never retyped) and hand-picked edge cases. Nothing reads a data
dir. Scenarios run the real ``match_internal_transfers`` / ``categorize_all`` / ``detect_recurring``
/ ``reclassify_all`` on one in-memory SQLite engine (``create_all``: every module's models), each
scenario rolled back. The LLM backends run against an ``httpx.MockTransport`` that records each
request and answers from a canned script; ``offline.install()`` blocks every real transport and
socket, so a missed patch fails instead of calling out (the blocked count is printed and must be 0).

File format as ``vectors.py``: JSON Lines, line 1 ``{"meta": {...}}``, then one JSON array per vector
(layout in ``meta.layout``).
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
import unicodedata
from collections.abc import Iterator
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))

import httpx
import offline
from sqlmodel import Session, SQLModel, create_engine, select

import cashu.models  # noqa: F401  (registers every table for create_all)
from cashu.config import settings
from cashu.core import modules as core_modules
from cashu.core.accounts import own_ibans
from cashu.core.mcp.names import looks_like_person
from cashu.core.models import Account, AccountType, Profile, Source
from cashu.core.text import normalize_text
from cashu.modules.budget import analytics, service
from cashu.modules.budget.categorize import engine as engine_mod
from cashu.modules.budget.categorize import llm as llm_mod
from cashu.modules.budget.categorize import (
    local_llm,
    taxonomy,
)
from cashu.modules.budget.categorize import reclassify as recl
from cashu.modules.budget.categorize.rules import load_rules
from cashu.modules.budget.ingestion.normalize import merchant_key
from cashu.modules.budget.ingestion.transfers import match_internal_transfers
from cashu.modules.budget.models import CategoryRule, Transaction
from cashu.modules.budget.queries import transactions as txn_query
from cashu.modules.loans.models import Loan

SEED = 20261102
OUT = ROOT / "packages" / "domain" / "test" / "vectors"
PID = 1
BASE_DAY = dt.date(2026, 1, 5)

if sys.version_info < (3, 14):
    raise SystemExit("vectors_budget_categorize.py needs Python 3.14+ (unicodedata / decimal pinned)")


# --------------------------------------------------------------------------- vocabulary

NEEDLES = [str(n) for n, _ in taxonomy.SEED_RULES]
PHRASES = [p for p, _ in core_modules.text_rules()] + [p for p, _ in taxonomy.TEXT_RULES]
SPECIAL = ["WYNAGRODZENIE", "PENSJA", "TRANSAKCJA WALUT", "PRZEWALUTOWANIE", "ZWROT", "CZYNSZ"]
# Synthetic person-like and business-like names (never real people).
PEOPLE = ["JAN TEST", "Anna Testowa", "MARIA PRÓBNA", "Łukasz Żółć", "Piotr Przykład", "EWA X"]
NOISE = ["SKLEP", "SP. Z O.O.", "PL", "WARSZAWA", "KRAKOW", "12345", "*", "/", "-", "ul.", "S.A.",
         "INTERNET", "ONLINE", "PAYU*", "BLIK", "P24", "KARTA", "1234XX5678"]
DIACRITIC_WORDS = ["żabka", "Ślęża", "łódź", "ZAŻÓŁĆ", "gęślą", "jaźń", "Café", "naïve", "ǅ", "ﬁ"]
TX_SUFFIX = [" DATA TRANSAKCJI: 2026-01-01", "  data transakcji: 2026-02-03", " DATA TRANſAKCJI: x",
             " DATA TRANSAKCJI: 2026", "      LOKALIZACJA PADDING"]
WS = [" ", "  ", "\t", " ", "\n", "　", "\x85", " "]


def needle_variants(needle: str) -> list[str]:
    """12 variants around one needle: word boundaries, digits, punctuation, case, whitespace,
    diacritics before normalization."""
    lower = needle.lower()
    spaced = needle.replace(" ", "  \t")
    return [
        needle,
        "X" + needle,
        needle + "X",
        "1" + needle,
        needle + "1234",
        "(" + needle + ")",
        " " + lower + " ",
        "ab " + needle + " cd",
        spaced,
        needle.replace("A", "Ą").replace("O", "Ó").replace("L", "Ł").replace("Z", "Ż"),
        needle + " DATA TRANSAKCJI: 2026-01-01",
        "_" + needle + "_",
    ]


def rand_merchant_text(rng: random.Random) -> str:
    parts: list[str] = []
    for _ in range(rng.randint(1, 4)):
        r = rng.random()
        if r < 0.45:
            parts.append(rng.choice(NEEDLES))
        elif r < 0.55:
            parts.append(rng.choice(PHRASES + SPECIAL))
        elif r < 0.65:
            parts.append(rng.choice(DIACRITIC_WORDS))
        elif r < 0.72:
            parts.append(rng.choice(PEOPLE))
        else:
            parts.append(rng.choice(NOISE))
    s = rng.choice(WS).join(parts)
    if rng.random() < 0.15:
        s = s.lower()
    if rng.random() < 0.1:
        s += rng.choice(TX_SUFFIX)
    if rng.random() < 0.05:
        s = rng.choice(WS) + s + rng.choice(WS)
    return s


def maybe_text(rng: random.Random, p: float = 0.7) -> str | None:
    r = rng.random()
    if r < 0.05:
        return ""
    if r < 1 - p:
        return None
    return rand_merchant_text(rng)


# --------------------------------------------------------------------------- seed / text rules


def gen_seed(rng: random.Random) -> list:
    rows: list = []
    module_rules = core_modules.text_rules()

    def row(raw: str) -> list:
        mk = merchant_key(raw)
        text = normalize_text(raw)
        return [raw, mk, taxonomy.apply_seed_rules(mk), text, taxonomy.apply_text_rules(text)]

    for needle in NEEDLES:
        for v in needle_variants(needle):
            rows.append(row(v))
    for phrase in PHRASES + SPECIAL:
        for v in needle_variants(phrase):
            rows.append(row(v))
    for _ in range(4000):
        rows.append(row(rand_merchant_text(rng)))
    assert module_rules, "module text rules must be registered"
    return rows


# --------------------------------------------------------------------------- engine

OWN_IBANS_RAW = ["PL61 1090 1014 0000 0712 1981 2874", "99 1000 0000 0000 0000 0000 0001", "DE89370400440532013000"]
FOREIGN_IBANS = ["99 2000 0000 0000 0000 0000 0002", "GB29NWBK60161331926819", "'99300000000000000000000003", "PL"]
AMOUNTS = ["-12.50", "-100", "-0", "0", "0.00", "-0.00", "15.99", "2500", "-49.99", "-1E+2", "-7.1", "-0.001",
           "3200.00", "-29.00", "-1500", "100"]


def iban_pick(rng: random.Random) -> str | None:
    r = rng.random()
    if r < 0.45:
        return None
    if r < 0.5:
        return ""
    if r < 0.7:
        own = rng.choice(OWN_IBANS_RAW)
        return rng.choice([own, own.replace(" ", ""), own.lower(), "'" + own])
    return rng.choice(FOREIGN_IBANS)


def rand_txn(rng: random.Random) -> dict:
    return {
        "amount": rng.choice(AMOUNTS) if rng.random() < 0.7 else f"{rng.choice('-+')}{rng.randint(0, 99999) / 100:.2f}".replace("+", ""),
        "counterpartyName": maybe_text(rng, 0.6),
        "counterpartyIban": iban_pick(rng),
        "description": maybe_text(rng, 0.5),
        "reference": maybe_text(rng, 0.7),
        "isInternalTransfer": rng.random() < 0.08,
    }


def txn_row(t: dict) -> list:
    return [t["amount"], t["counterpartyName"], t["counterpartyIban"], t["reference"], t["description"],
            t["isInternalTransfer"]]


def txn_obj(t: dict) -> Transaction:
    return Transaction(
        account_id=1, booking_date=BASE_DAY, amount=Decimal(t["amount"]), currency="PLN",
        counterparty_name=t["counterpartyName"], counterparty_iban=t["counterpartyIban"],
        description=t["description"], reference=t["reference"],
        is_internal_transfer=t["isInternalTransfer"], source=Source.CSV, dedup_hash="x",
    )


def rand_rules(rng: random.Random, keys: list[str]) -> list[list]:
    out: list[list] = []
    for k in keys:
        if rng.random() < 0.3:
            source = rng.choice(["manual", "llm"])
            locked = rng.choice([True, False]) if rng.random() < 0.3 else source == "manual"
            out.append([k, rng.choice(taxonomy.CATEGORY_KEYS), source, locked])
    if rng.random() < 0.1:
        out.append(["", rng.choice(taxonomy.CATEGORY_KEYS), rng.choice(["manual", "llm"]), rng.random() < 0.5])
    return out


def rand_patterns(rng: random.Random) -> list[list]:
    out: list[list] = []
    for _ in range(rng.randint(0, 3)):
        kind = rng.random()
        iban = rng.choice(FOREIGN_IBANS + OWN_IBANS_RAW) if kind < 0.6 else None
        text = normalize_text(rng.choice(PHRASES + NEEDLES + ["rata 12", "spłata"])) if kind > 0.4 else None
        out.append([rng.choice(["loans", "housing", "fees"]), iban, text or None])
    return out


def rule_objs(rules: list[list]) -> dict[str, CategoryRule]:
    return {k: CategoryRule(merchant_key=k, category=c, source=s, locked=lk, profile_id=PID)
            for k, c, s, lk in rules}


def pattern_objs(patterns: list[list]) -> list[core_modules.PaymentPattern]:
    return [core_modules.PaymentPattern(c, counterparty_iban=i, text=t) for c, i, t in patterns]


def gen_engine(rng: random.Random) -> list:
    rows: list = []
    own = {recl_iban_key(i) for i in OWN_IBANS_RAW}
    for n in range(6000):
        txns = [rand_txn(rng) for _ in range(rng.randint(1, 4))]
        keys = [merchant_key(t["counterpartyName"], t["reference"], t["description"]) for t in txns]
        rules = rand_rules(rng, keys)
        patterns = rand_patterns(rng)
        subs = [k for k in keys if rng.random() < 0.3]
        ro, po = rule_objs(rules), pattern_objs(patterns)
        out = []
        for t in txns:
            obj = txn_obj(t)
            od = engine_mod.owner_decision(obj, own_ibans=own, rules=ro, patterns=po)
            cat = engine_mod.categorize(obj, own_ibans=own, rules=ro, subscription_keys=set(subs), patterns=po)
            out.append([list(od) if od else None, list(cat)])
        rows.append([n, [txn_row(t) for t in txns], rules, patterns, subs, out])
    return rows


def recl_iban_key(v: str) -> str:
    from cashu.core.text import iban_key

    return iban_key(v)


# --------------------------------------------------------------------------- scenarios (DB)


def make_engine():
    engine = create_engine("sqlite://")
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        s.add(Profile(id=PID, slug="test-a", name="Test A"))
        s.add(Profile(id=2, slug="test-b", name="Test B"))
        s.commit()
    return engine


@contextlib.contextmanager
def scenario_session(engine) -> Iterator[Session]:
    with engine.connect() as conn:
        trans = conn.begin()
        session = Session(bind=conn, join_transaction_mode="create_savepoint")
        try:
            yield session
        finally:
            session.close()
            trans.rollback()


PAYEES = ["NETFLIX.COM", "SPOTIFY", "SIŁOWNIA FIT", "ORANGE POLSKA", "KLUB TEST", "SKLEP TESTOWY",
          "JAN TEST", "Wspólnota Mieszkaniowa Test", "BANK TEST RATA KREDYTU", "APTEKA TEST", "ZABKA Z1234",
          "PRZELEW WŁASNY", "OPŁATA ZA KARTĘ", "Czynsz za lokal", "XYZ SERVICE", "SALON TEST"]
TITLES = [None, "", "PŁATNOŚĆ KARTĄ", "Przelew", "rata kredytu 12/120", "czynsz 01", "subskrypcja",
          "DATA TRANSAKCJI: 2026-01-01", "Wynagrodzenie 01/2026", "zwrot", "TRANSAKCJA WALUTOWA",
          "spłata pożyczki"]
ACC_IBANS = ["99 1000 0000 0000 0000 0000 0101", "PL99 1000 0000 0000 0000 0000 0202", "'99100000000000000000000303",
             "NO9386011117947", "99100000000000000000000404"]
CURRENCIES = ["PLN", "PLN", "PLN", "EUR"]
STORED = [(None, None), ("other", "default"), ("groceries", "keyword"), ("subscriptions", "subscription"),
          ("dining", "manual_txn"), ("housing", "manual_txn"), ("entertainment", "llm_full"),
          ("transport", "llm_fallback"), ("private", "manual_txn"), ("loans", "keyword"),
          ("shopping", "manual"), ("transfer", "transfer"), ("cash", "llm_full"), ("fees", "llm_full")]


def build_scenario(rng: random.Random, s: Session, size: tuple[int, int] = (10, 80)) -> dict:
    """Accounts, rows, rules and loans of one synthetic profile. Returns the input description."""
    n_acc = rng.randint(1, 3)
    accounts: list[Account] = []
    for i in range(n_acc):
        iban = ACC_IBANS[i] if rng.random() < 0.85 else None
        a = Account(bank="mbank", name=f"Konto {i}", iban=iban, currency="PLN", profile_id=PID,
                    external_id=f"acc{i}")
        if rng.random() < 0.1:
            a.removed_at = dt.datetime(2026, 1, 1, tzinfo=dt.UTC)
        accounts.append(a)
    cash = Account(bank="manual", name="Gotówka", currency="PLN", type=AccountType.CASH,
                   external_id="cash:PLN", profile_id=PID)
    accounts.append(cash)
    other = Account(bank="mbank", name="Obce", iban=ACC_IBANS[4], profile_id=2, external_id="other")
    for a in [*accounts, other]:
        s.add(a)
    s.flush()
    bank_ids = [a.id for a in accounts if a.type != AccountType.CASH]

    loans: list[Loan] = []
    if rng.random() < 0.4:
        loan_acc = Account(bank="manual", name="Kredyt", type=AccountType.MORTGAGE, profile_id=PID,
                           external_id="loan1")
        s.add(loan_acc)
        s.flush()
        lp = Loan(account_id=loan_acc.id, principal=Decimal(100000), annual_rate=Decimal("6.5"),
                  term_months=120, start_date=dt.date(2025, 1, 1),
                  payment_iban=rng.choice([None, "PL" + ACC_IBANS[4].replace(" ", ""), "99 5000 0000 0000 0000 0000 0005"]),
                  payment_text=rng.choice([None, "", "rata 1", "Bank Test", "spłata"]))
        s.add(lp)
        loans.append(lp)

    months = rng.randint(4, 8)
    n_rows = rng.randint(*size)
    payees = rng.sample(PAYEES, rng.randint(3, len(PAYEES)))
    plans = []
    for p in payees:
        plans.append({
            "payee": p, "amount": rng.choice(["-29.99", "-49.00", "-1500.00", "-15", "-15.00", "-120.50", "-0"]),
            "gap": rng.choice([30, 31, 28, 24, 37, 14, 45, 0]), "acc": rng.choice(bank_ids),
            "cur": rng.choice(CURRENCIES), "cash": rng.random() < 0.08,
        })
    produced = 0
    while produced < n_rows:
        p = rng.choice(plans)
        k = rng.randint(1, months)
        day = BASE_DAY
        for j in range(k):
            if produced >= n_rows:
                break
            day = day + dt.timedelta(days=p["gap"] + rng.choice([0, 0, 0, 1, -1, 3]))
            amount = p["amount"] if rng.random() < 0.85 else rng.choice(AMOUNTS)
            acc = cash.id if p["cash"] else p["acc"]
            cur = "PLN" if p["cash"] else p["cur"]
            stored = rng.choice(STORED) if rng.random() < 0.3 else (None, None)
            if p["cash"]:
                stored = rng.choice([(rng.choice(taxonomy.CATEGORY_KEYS), "manual_txn"), ("cash_withdrawal", "cash_leg"),
                                     (None, None), ("other", "default")])
            t = Transaction(
                account_id=acc, booking_date=day, amount=Decimal(amount), currency=cur,
                counterparty_name=p["payee"] if rng.random() < 0.8 else None,
                counterparty_iban=rng.choice([None, None, ACC_IBANS[rng.randint(0, 4)], "99 5000 0000 0000 0000 0000 0005"]),
                reference=rng.choice(TITLES) if rng.random() < 0.6 else p["payee"],
                description=rng.choice([None, None, rand_merchant_text(rng)]),
                category=stored[0], category_source=stored[1], source=Source.CSV,
                dedup_hash=f"h{produced}",
            )
            s.add(t)
            produced += 1
    # Transfer pairs between own accounts (S08 matches them).
    if len(bank_ids) > 1:
        for _ in range(rng.randint(0, 3)):
            a, b = rng.sample(bank_ids, 2)
            amt = rng.choice(["100.00", "250.50", "1000"])
            day = BASE_DAY + dt.timedelta(days=rng.randint(0, 120))
            acc_b = next(x for x in accounts if x.id == b)
            s.add(Transaction(account_id=a, booking_date=day, amount=-Decimal(amt), currency="PLN",
                              counterparty_iban=acc_b.iban, reference="Przelew własny", source=Source.CSV,
                              dedup_hash=f"t{a}{day}{amt}"))
            s.add(Transaction(account_id=b, booking_date=day, amount=Decimal(amt), currency="PLN",
                              reference="Przelew własny", source=Source.CSV, dedup_hash=f"u{b}{day}{amt}"))
            produced += 2
    s.flush()
    # Rules on some payees' keys.
    keys = sorted({merchant_key(t.counterparty_name, t.reference, t.description)
                   for t in s.exec(txn_query(PID)).all()})
    for k in keys:
        if rng.random() < 0.15:
            src = rng.choice(["manual", "llm"])
            s.add(CategoryRule(merchant_key=k, category=rng.choice(taxonomy.CATEGORY_KEYS), source=src,
                               locked=src == "manual" if rng.random() < 0.8 else rng.random() < 0.5,
                               profile_id=PID))
    s.flush()
    return {"accounts": accounts, "cash_id": cash.id}


def snapshot_rows(s: Session) -> list[Transaction]:
    return sorted(s.exec(txn_query(PID)).all(), key=lambda t: t.id)


ROW_FIELDS = ["id", "account", "onCashAccount", "bookingDate", "amount", "currency", "counterpartyName",
              "counterpartyIban", "reference", "description", "isInternalTransfer", "category", "source"]


def row_in(t: Transaction, cash_id: int, acc_index: dict[int, int]) -> list:
    return [t.id, acc_index.get(t.account_id, -1), t.account_id == cash_id, t.booking_date.isoformat(),
            str(t.amount), t.currency, t.counterparty_name, t.counterparty_iban, t.reference, t.description,
            t.is_internal_transfer, t.category, t.category_source]


def candidate_out(c) -> list:
    return [c.counterparty, str(c.typical_amount), c.occurrences, c.months_covered, c.median_gap_days,
            c.last_date.isoformat(), c.currency]


def context_of(s: Session) -> dict:
    accounts = s.exec(select(Account).where(Account.profile_id == PID)).all()
    return {
        "accountIbans": [a.iban for a in accounts],
        "ownIbans": sorted(own_ibans(s, PID)),
        "rules": [[r.merchant_key, r.category, r.source, r.locked]
                  for r in sorted(load_rules(s, PID).values(), key=lambda r: r.merchant_key)],
        "patterns": [[p.category, p.counterparty_iban, p.text] for p in core_modules.payment_patterns(s, PID)],
    }


def gen_all(rng: random.Random, engine) -> list:
    rows: list = []
    for n in range(400):
        with scenario_session(engine) as s:
            info = build_scenario(rng, s)
            match_internal_transfers(s, profile_id=PID)
            s.flush()
            acc_index = {a.id: i for i, a in enumerate(info["accounts"])}
            before = snapshot_rows(s)
            inputs = [row_in(t, info["cash_id"], acc_index) for t in before]
            ctx = context_of(s)
            order = [t.id for t in s.exec(txn_query(PID, Transaction.is_internal_transfer == False)).all()]
            recurring = analytics.detect_recurring(s, profile_id=PID)
            service.categorize_all(s, use_llm=False, profile_id=PID)
            s.flush()
            after = {t.id: [t.category, t.category_source] for t in snapshot_rows(s)}
            rows.append([n, ctx, inputs, order, [after[r[0]] for r in inputs],
                         [candidate_out(c) for c in recurring],
                         sorted({c.counterparty for c in recurring})])
    return rows


# --------------------------------------------------------------------------- LLM (mock transport)


class Recorder:
    def __init__(self, rng: random.Random):
        self.rng = rng
        self.requests: list = []
        self.replies: list = []
        self.mode = "ok"

    def reply_for(self, ids: list[str], allowed: list[str]) -> dict:
        rng = self.rng
        results = []
        for i in ids:
            if rng.random() < 0.1:
                continue
            item: dict = {"id": i}
            r = rng.random()
            item["category"] = (rng.choice(allowed) if r < 0.7 else
                                rng.choice(["UNKNOWN", "nonsense", "private", "transfer", "cash_withdrawal", None, 5]))
            c = rng.random()
            if c < 0.6:
                item["confidence"] = round(rng.random(), 3)
            elif c < 0.7:
                item["confidence"] = rng.choice([1.5, -0.2, True, "0.7", "x", None, [1], 2])
            results.append(item)
        if rng.random() < 0.1:
            results.append({"id": "m999" if rng.random() < 0.5 else "t999", "category": allowed[0]})
        if rng.random() < 0.05 and ids:
            results.append({"id": 0, "category": allowed[0]})
        return {"results": results}

    def content(self, ids: list[str], allowed: list[str]) -> str:
        r = self.rng.random()
        if r < 0.05:
            return "{not json"
        if r < 0.08:
            return json.dumps([1, 2])
        if r < 0.1:
            return json.dumps({"results": ["x"]})
        if r < 0.12:
            return json.dumps({"other": 1})
        return json.dumps(self.reply_for(ids, allowed), ensure_ascii=self.rng.random() < 0.5)

    def handle(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        self.requests.append([str(request.url), compact_body(body)])
        if "max_tokens" in body:  # anthropic
            text = body["messages"][0]["content"]
            items = json.loads(text.split("\n", 1)[1])
            ids = [x["id"] for x in items]
            allowed = body["output_config"]["format"]["schema"]["properties"]["results"]["items"]["properties"]["category"]["enum"]
            if self.rng.random() < 0.05:
                self.replies.append(["status", 500])
                return httpx.Response(500, json={"error": "x"})
            content = self.content(ids, allowed)
            data = {"content": [{"type": "thinking", "text": "{}"}] if self.rng.random() < 0.1 else []}
            data["content"].append({"type": "text", "text": content})
            self.replies.append(["ok", data])
            return httpx.Response(200, json=data)
        user = body["messages"][1]["content"]
        if user.startswith("Classify:\n"):
            ids = [ln.split(":", 1)[0] for ln in user[len("Classify:\n"):].split("\n")]
        else:
            ids = [ln[1:-1] for ln in user.split("\n") if ln.startswith("[t") and ln.endswith("]")]
        allowed = body["format"]["properties"]["results"]["items"]["properties"]["category"]["enum"]
        if self.rng.random() < 0.04:
            self.replies.append(["status", 503])
            return httpx.Response(503, text="down")
        content = self.content(ids, allowed)
        self.replies.append(["ok", content])
        return httpx.Response(200, json={"message": {"content": content}})


def shared_bodies() -> dict[str, object]:
    keys = taxonomy.AUTO_CATEGORY_KEYS
    allowed = [k for k in keys if k not in recl.STRUCTURAL_CATEGORIES]
    labels = {k: v for k, v in taxonomy.LABELS.items() if k in allowed}
    return {
        "$OLLAMA_MERCHANT_SYSTEM": local_llm._system_prompt(keys),
        "$OLLAMA_TXN_SYSTEM": local_llm._txn_system_prompt(labels),
        "$OLLAMA_SCHEMA": local_llm._schema(keys),
        "$OLLAMA_TXN_SCHEMA": local_llm._schema(allowed),
        "$ANTHROPIC_SYSTEM": llm_mod._build_system_blocks(keys),
        "$ANTHROPIC_SCHEMA": llm_mod._build_schema(keys),
    }


def compact_body(body: dict) -> dict:
    """The request body with the shared prompts / schemas (pinned in matching data) as tokens."""
    shared = shared_bodies()
    tokens = {json.dumps(v, sort_keys=True): k for k, v in shared.items()}

    def tok(v):
        return tokens.get(json.dumps(v, sort_keys=True), v)

    out = dict(body)
    if "max_tokens" in out:
        out["system"] = tok(out["system"])
        out["output_config"] = {"format": {**out["output_config"]["format"],
                                           "schema": tok(out["output_config"]["format"]["schema"])}}
    else:
        out["format"] = tok(out["format"])
        msgs = [dict(m) for m in out["messages"]]
        msgs[0]["content"] = tok(msgs[0]["content"])
        out["messages"] = msgs
    return out


@contextlib.contextmanager
def mock_http(rec: Recorder) -> Iterator[None]:
    real = httpx.Client
    transport = httpx.MockTransport(rec.handle)

    class MockClient(real):  # type: ignore[misc, valid-type]
        def __init__(self, *args, **kwargs):
            kwargs["transport"] = transport
            super().__init__(*args, **kwargs)

    httpx.Client = MockClient  # type: ignore[misc]
    try:
        yield
    finally:
        httpx.Client = real  # type: ignore[misc]


@contextlib.contextmanager
def backend(name: str) -> Iterator[None]:
    cls = type(settings)
    saved_prop = cls.resolved_api_key
    saved_backend = settings.categorize_llm_backend
    cls.resolved_api_key = property(lambda self: "test-key")  # never the keychain
    settings.categorize_llm_backend = name
    try:
        yield
    finally:
        cls.resolved_api_key = saved_prop
        settings.categorize_llm_backend = saved_backend


MERCHANT_EDGE = ["ŁÓDŹ \"CAFÉ\"", "A\\B", "line\nbreak", "tab\there", "\x00\x01\x1f\x7f", "😀 EMOJI", " sep",
                 "ZABKA", "", "ZABKA", "Jan Test", "퟿", " nbsp", "ß", "q\"u'o"]


def gen_llm(rng: random.Random, engine) -> list:
    rows: list = []
    # (a) the backends on raw merchant lists (json.dumps, dedupe, batching, parsing).
    for n in range(120):
        merchants = [rng.choice(MERCHANT_EDGE) if rng.random() < 0.3 else rand_merchant_text(rng)
                     for _ in range(rng.randint(0, 90))]
        name = rng.choice(["ollama", "anthropic"])
        rec = Recorder(rng)
        keys = taxonomy.AUTO_CATEGORY_KEYS if rng.random() < 0.8 else rng.sample(taxonomy.CATEGORY_KEYS, 5)
        with mock_http(rec):
            try:
                if name == "ollama":
                    res = local_llm.classify_merchants(merchants, keys)
                else:
                    res = llm_mod.classify_merchants(merchants, keys, api_key="test-key")
                result = {m: [r["category"], r["confidence"]] for m, r in res.items()}
            except AttributeError:  # a non-object reply escapes local_llm (classify_unknown catches it)
                result = {"error": "AttributeError"}
        rows.append(["merchants", n, name, merchants, keys, rec.requests, rec.replies, result,
                     {m: looks_like_person(m) for m in dict.fromkeys(merchants) if m}])
    # (b) categorize_all(use_llm=True) end to end.
    for n in range(300):
        name = rng.choice(["ollama", "anthropic"])
        with scenario_session(engine) as s:
            info = build_scenario(rng, s, (8, 40))
            match_internal_transfers(s, profile_id=PID)
            s.flush()
            acc_index = {a.id: i for i, a in enumerate(info["accounts"])}
            inputs = [row_in(t, info["cash_id"], acc_index) for t in snapshot_rows(s)]
            ctx = context_of(s)
            rec = Recorder(rng)
            with mock_http(rec), backend(name):
                try:
                    result = service.categorize_all(s, use_llm=True, profile_id=PID)
                    outcome = {k: v for k, v in result.items() if k != "llm_error"}
                    outcome["llm_error"] = "llm_error" in result
                except AttributeError:  # Q11-like: a non-object reply escapes (anthropic catches all)
                    outcome = {"error": "AttributeError"}
            s.flush()
            rules_after = [[r.merchant_key, r.category, r.source, r.locked]
                           for r in sorted(load_rules(s, PID).values(), key=lambda r: r.merchant_key)]
            unknown = []
            for req in rec.requests:
                body = req[1]
                if "max_tokens" in body:
                    unknown += [x["merchant"] for x in json.loads(body["messages"][0]["content"].split("\n", 1)[1])]
                else:
                    unknown += [ln.split(": ", 1)[1] for ln in body["messages"][1]["content"][len("Classify:\n"):].split("\n")]
            rows.append(["pass", n, name, ctx, inputs, rec.requests, rec.replies, outcome, rules_after,
                         {m: looks_like_person(m) for m in unknown}])
    return rows


# --------------------------------------------------------------------------- reclassify

DATE_BITS = ["DATA TRANSAKCJI: 2026-01-01", "data transakcji:x", "DATA TRANſAKCJI: 1", "DATA TRANſAKCJI: 2",
             "DATA TRANSAKCJI: 3", "DATA TRANSAKCJİ: 4", "DATA TRANSAKCJı: 5"]
CARD_BITS = ["123456******1234", "123456*123", "١٢٣٤٥٦**١٢٣", "12345*1234", "123456****12345"]
AMOUNT_BITS = ["82.54 PLN", "19,99", "1 234,56 EUR", "0.00usd", "12.3", "١٢.٣٤ pln", "5 000.00 PLN",
               "9.99 GBP", "7,77CHF", "1.00 nok", "100.00 HUF"]
LONGNUM_BITS = ["123456", "12/34/56", "1234567890123", "00000/1111", "١٢٣٤٥٦", "12345"]
ODD = [" ", "é", "\n", "\r", "|", " | ", "ǅ", "ﬁ", "ẞ", "İ", "KelvinK", "ſ", "\x85", "　"]


def rand_recl_text(rng: random.Random) -> str | None:
    if rng.random() < 0.15:
        return rng.choice([None, ""])
    bits = []
    for _ in range(rng.randint(1, 6)):
        pool = rng.choice([DATE_BITS, CARD_BITS, AMOUNT_BITS, LONGNUM_BITS, ODD, NEEDLES, PEOPLE, NOISE, DIACRITIC_WORDS])
        bits.append(rng.choice(pool))
    s = rng.choice([" ", "", "  ", "\t"]).join(bits)
    if rng.random() < 0.1:
        s += "\n"
    return s


def gen_reclassify(rng: random.Random, engine) -> list:
    rows: list = []
    for _ in range(3000):
        t = {"counterpartyName": rand_recl_text(rng), "reference": rand_recl_text(rng),
             "description": rand_recl_text(rng)}
        if rng.random() < 0.2:
            t["description"] = t["reference"]
        amounts = [rng.choice(AMOUNTS + ["-0", "0", "-0.00", "12.345", "-12.355"]) for _ in range(rng.randint(1, 4))]
        obj = Transaction(account_id=1, booking_date=BASE_DAY, amount=Decimal(amounts[0]),
                          currency=rng.choice(["PLN", "EUR"]), counterparty_name=t["counterpartyName"],
                          reference=t["reference"], description=t["description"], source=Source.CSV,
                          dedup_hash="x")
        rows.append(["text", t, obj.currency, amounts, recl.txn_signature(obj),
                     recl.txn_context(obj, [Decimal(a) for a in amounts])])
    for n in range(200):
        with scenario_session(engine) as s:
            info = build_scenario(rng, s, (8, 40))
            match_internal_transfers(s, profile_id=PID)
            s.flush()
            acc_index = {a.id: i for i, a in enumerate(info["accounts"])}
            inputs = [row_in(t, info["cash_id"], acc_index) for t in snapshot_rows(s)]
            ctx = context_of(s)
            order = [t.id for t in s.exec(txn_query(PID)).all()]
            rec = Recorder(rng)
            limit = rng.choice([None, None, 1, 3, 10])
            dfrom = rng.choice([None, None, BASE_DAY + dt.timedelta(days=60)])
            dto = rng.choice([None, None, BASE_DAY + dt.timedelta(days=150)])
            with mock_http(rec):
                try:
                    stats = recl.reclassify_all(s, model="test-model", url="http://mock.invalid", batch_size=rng.choice([20, 3]),
                                                limit=limit, date_from=dfrom, date_to=dto, profile_id=PID)
                    stats = {k: stats[k] for k in ("targets", "groups", "classified_txns", "fallback_txns", "configured_txns")}
                except AttributeError:
                    stats = {"error": "AttributeError"}
            s.flush()
            final = {t.id: [t.category, t.category_source] for t in snapshot_rows(s)}
            rows.append(["scenario", n, ctx, inputs, order,
                         {"limit": limit, "dateFrom": dfrom and dfrom.isoformat(), "dateTo": dto and dto.isoformat()},
                         rec.requests, rec.replies, stats, [final[r[0]] for r in inputs]])
    return rows


# --------------------------------------------------------------------------- matching data


def str_constants(fn) -> list[str]:
    tree = ast.parse(inspect.getsource(fn))
    return [n.value for n in ast.walk(tree) if isinstance(n, ast.Constant) and isinstance(n.value, str)]


def matching_data() -> dict:
    allowed = [k for k in taxonomy.AUTO_CATEGORY_KEYS if k not in recl.STRUCTURAL_CATEGORIES]
    labels = {k: v for k, v in taxonomy.LABELS.items() if k in allowed}
    anth_payload = llm_mod._build_payload([("m0", "X")], taxonomy.AUTO_CATEGORY_KEYS, model="claude-haiku-4-5")
    anth_prefix = anth_payload["messages"][0]["content"][: -len(json.dumps([{"id": "m0", "merchant": "X"}]))]
    data = {
        "categories": [[c.key, c.label, c.kind] for c in taxonomy.CATEGORIES],
        "labelsEn": taxonomy.LABELS_EN,
        "manualOnly": sorted(taxonomy.MANUAL_ONLY),
        "autoCategoryKeys": taxonomy.AUTO_CATEGORY_KEYS,
        "seedRules": [[str(n), c, isinstance(n, taxonomy.word)] for n, c in taxonomy.SEED_RULES],
        "textRules": [list(r) for r in taxonomy.TEXT_RULES],
        "moduleTextRules": [list(r) for r in core_modules.text_rules()],
        "notSubscription": sorted(analytics.NOT_SUBSCRIPTION_CATEGORIES),
        "moduleNotSubscription": sorted(core_modules.not_subscription_categories()),
        "txnDecidedSources": sorted(analytics._TXN_DECIDED_SOURCES),
        "ownerSources": sorted(recl.OWNER_SOURCES),
        "structuralCategories": sorted(recl.STRUCTURAL_CATEGORIES),
        "keepOnMerchantPin": sorted(service._KEEP_ON_MERCHANT_PIN),
        "reclassifyRegexes": {k: [getattr(recl, k).pattern, int(getattr(recl, k).flags)]
                              for k in ("_DATES", "_CARD", "_AMOUNT", "_LONGNUM", "_WS")},
        "engineLiterals": str_constants(engine_mod),
        "contextLiterals": str_constants(recl.txn_context),
        "ollamaMerchantSystem": local_llm._system_prompt(taxonomy.AUTO_CATEGORY_KEYS),
        "ollamaTxnSystem": local_llm._txn_system_prompt(labels),
        "anthropicSystem": llm_mod._build_system_blocks(taxonomy.AUTO_CATEGORY_KEYS),
        "ollamaSchema": local_llm._schema(taxonomy.AUTO_CATEGORY_KEYS),
        "anthropicSchema": llm_mod._build_schema(taxonomy.AUTO_CATEGORY_KEYS),
        "anthropicUserPrefix": anth_prefix,
        "reclassifyAllowed": allowed,
        "defaults": {
            "ollamaModel": inspect.signature(local_llm.classify_merchants).parameters["model"].default,
            "ollamaBatch": inspect.signature(local_llm.classify_merchants).parameters["batch_size"].default,
            "ollamaTxnBatch": inspect.signature(local_llm.classify_transactions).parameters["batch_size"].default,
            "anthropicModel": inspect.signature(llm_mod.classify_merchants).parameters["model"].default,
            "anthropicBatch": inspect.signature(llm_mod.classify_merchants).parameters["batch_size"].default,
            "settingsModel": type(settings).model_fields["categorize_model"].default,
            "settingsOllamaModel": type(settings).model_fields["categorize_ollama_model"].default,
            "settingsBackend": type(settings).model_fields["categorize_llm_backend"].default,
        },
        "sharedBodies": shared_bodies(),
        "unidataVersion": unicodedata.unidata_version,
    }
    canon = json.dumps(data, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return {"data": data, "sha256": hashlib.sha256(canon.encode()).hexdigest()}


# --------------------------------------------------------------------------- output

LAYOUTS = {
    "seed": "[raw, merchant_key(raw), apply_seed_rules(mk), normalize_text(raw), apply_text_rules(text)]",
    "engine": "[case, txns[[amount, cpName, cpIban, reference, description, internal]], rules[[mk,cat,src,locked]], patterns[[cat,iban,text]], subscription_keys, [[owner_decision|null, categorize]] per txn]",
    "all": "[scenario, ctx{accountIbans, ownIbans, rules, patterns}, rows (id order, after transfer matching, stored before; fields ROW_FIELDS), non-internal query order (ids), [category, source] per row after categorize_all(use_llm=False), detect_recurring() before the run (the one categorize_all uses), payees]",
    "llm": "['merchants', n, backend, merchants, keys, requests[[url, body]], replies, result{m:[cat,conf]}, personLike{m:bool}] | ['pass', n, backend, ctx, rows, requests, replies, outcome, rules after, personLike]",
    "matching-data": "[{data: the live Python objects (prompts, rule tables, sets, regexes, literals, defaults), sha256: of json.dumps(data, ensure_ascii=False, sort_keys=True, separators=(',', ':'))}]",
    "reclassify": "['text', txn, currency, amounts, txn_signature, txn_context] | ['scenario', n, ctx, rows, query order, opts, requests, replies, stats, final [cat, src] per row]",
}


def no_em_dash(text: str) -> str:
    """U+2014 (in the Python prompts) as a JSON escape: the repository keeps no literal em dash."""
    return text.replace("\u2014", "\\u2014")


def dump(name: str, rows: list) -> str:
    head = {"meta": {"rowFields": ROW_FIELDS, "sharedBodies": "matching data .sharedBodies","name": f"budget-categorize-{name}", "count": len(rows), "layout": LAYOUTS[name],
                     "generator": "parity/python/vectors_budget_categorize.py", "seed": SEED,
                     "unidata": unicodedata.unidata_version}}
    lines = [json.dumps(head, ensure_ascii=False)]
    lines += [json.dumps(r, ensure_ascii=False, separators=(",", ":")) for r in rows]
    return no_em_dash("\n".join(lines) + "\n")


def generate() -> dict[str, str]:
    offline.install()
    engine = create_engine_once()
    files: dict[str, str] = {}
    files["budget-categorize-seed.jsonl"] = dump("seed", gen_seed(random.Random(SEED)))
    files["budget-categorize-engine.jsonl"] = dump("engine", gen_engine(random.Random(SEED + 1)))
    files["budget-categorize-all.jsonl"] = dump("all", gen_all(random.Random(SEED + 2), engine))
    files["budget-categorize-llm.jsonl"] = dump("llm", gen_llm(random.Random(SEED + 3), engine))
    files["budget-categorize-reclassify.jsonl"] = dump("reclassify", gen_reclassify(random.Random(SEED + 4), engine))
    files["budget-categorize-matching-data.jsonl"] = dump("matching-data", [[matching_data()]])
    if offline.blocked():
        raise SystemExit(f"network attempts blocked: {offline.blocked()}")
    print(f"socket guard: {offline.blocked()} blocked attempts", file=sys.stderr)
    return files


def create_engine_once():
    return make_engine()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()
    files = generate()
    bad = []
    for name, text in files.items():
        path = OUT / name
        if args.check:
            if not path.exists() or path.read_text(encoding="utf-8") != text:
                bad.append(name)
        else:
            path.write_text(text, encoding="utf-8")
    if bad:
        raise SystemExit(f"stale vectors: {', '.join(bad)}")
    print(("checked " if args.check else "wrote ") + ", ".join(f"{n} ({t.count(chr(10))} lines)" for n, t in files.items()))


if __name__ == "__main__":
    main()
