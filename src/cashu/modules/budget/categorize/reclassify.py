"""Full re-classification of every real income/expense transaction with a local
LLM, using the *whole* transaction (counterparty + title + description + amount),
not just the merchant name.

Why not reuse the merchant_key rule cache? Because it assumes one merchant → one
category, which is wrong for payment gateways / BLIK (PayU, PayPro, Przelewy24,
DotPay, PayPal, …): the real merchant lives in the transaction detail, so the same
operator legitimately maps to many categories. Here we group by a *full-detail
signature* (so identical rows are classified once) and let the model read the
details.

Structural money-movement bookkeeping is left untouched: internal transfers,
own-account moves, FX conversions, and the cash pool (transfer / cash_withdrawal
categories, and everything on a CASH account) are never reclassified — rewriting
them as spending would corrupt net worth and the cash pool.
"""

from __future__ import annotations

import re
import unicodedata
from collections import defaultdict
from decimal import Decimal

from sqlmodel import Session, select

from cashu.core import modules, profiles
from cashu.core.accounts import own_ibans
from cashu.core.models import Account, AccountType

from ..models import Transaction
from ..queries import transactions
from . import taxonomy

_DATES = re.compile(r"DATA TRANSAKCJI:.*$", re.IGNORECASE)
_CARD = re.compile(r"\d{6}\*+\d{3,4}")
_AMOUNT = re.compile(r"\d[\d ]*[.,]\d{2}\s*(?:PLN|EUR|USD|NOK|HUF|GBP|CHF)?", re.IGNORECASE)
_LONGNUM = re.compile(r"\b[\d/]{6,}\b")
_WS = re.compile(r"\s+")

# Categories that are structural (not spend/income) — never reclassified.
STRUCTURAL_CATEGORIES = {"transfer", "cash_withdrawal"}


def _strip_accents(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c))


def txn_signature(t: Transaction) -> str:
    """Stable key grouping transactions that carry the same descriptive text.

    Volatile parts (dates, card masks, amounts, long ref/id numbers) are removed
    so, e.g., every 'LIDL … PŁATNOŚĆ KARTĄ <amount>' collapses to one group, while
    'PayU*Allegro' and 'PayU*Steam' stay distinct."""
    raw = " | ".join([t.counterparty_name or "", t.reference or "", t.description or ""])
    s = _DATES.sub("", raw)
    s = _CARD.sub("", s)
    s = _AMOUNT.sub("", s)
    s = _LONGNUM.sub("", s)
    s = _WS.sub(" ", _strip_accents(s)).upper().strip(" |")
    return s or _WS.sub(" ", raw).strip().upper()


def txn_context(rep: Transaction, amounts: list[Decimal]) -> str:
    """Human-readable transaction context handed to the model."""
    lines: list[str] = []
    if rep.counterparty_name:
        lines.append(f"Odbiorca/nadawca: {rep.counterparty_name}")
    if rep.reference:
        lines.append(f"Tytuł: {rep.reference}")
    if rep.description and rep.description != rep.reference:
        lines.append(f"Opis: {rep.description}")
    lo, hi = min(amounts), max(amounts)
    if lo == hi:
        kind = "wpływ" if lo > 0 else "wydatek"
        lines.append(f"Kwota: {lo:.2f} {rep.currency} ({kind})")
    else:
        kind = "wpływy" if lo >= 0 else ("wydatki" if hi <= 0 else "mieszane")
        lines.append(
            f"Kwoty ({len(amounts)}× wyst.): od {lo:.2f} do {hi:.2f} {rep.currency} ({kind})"
        )
    if not lines[:-1]:  # no text at all — surface that explicitly
        lines.insert(0, "Odbiorca/nadawca: (brak danych)")
    return "\n".join(lines)


def _is_structural(t: Transaction, own_ibans: set[str], cash_ids: set[int]) -> bool:
    from ..ingestion.normalize import iban_key

    if t.account_id in cash_ids:
        return True
    if t.is_internal_transfer or (t.category in STRUCTURAL_CATEGORIES):
        return True
    cp = iban_key(t.counterparty_iban) if t.counterparty_iban else ""
    return bool(cp and cp in own_ibans)


def reclassify_all(
    session: Session,
    *,
    model: str | None = None,
    url: str | None = None,
    batch_size: int = 20,
    limit: int | None = None,
    date_from=None,
    date_to=None,
    progress=None,
    profile_id: int | None = None,
) -> dict:
    """Reclassify every real income/expense transaction via the local LLM,
    overwriting whatever was set before (including manual). Returns stats.

    date_from / date_to (inclusive) bound which transactions are targeted — used to
    run a stronger model on recent transactions and a faster one on the older tail."""
    from cashu.config import settings

    from . import engine, local_llm
    from .rules import load_rules

    model = model or settings.categorize_ollama_model
    url = url or settings.categorize_ollama_url
    pid = profiles.scope(session, profile_id)
    cash_ids = {
        a.id
        for a in session.exec(
            select(Account).where(Account.profile_id == pid, Account.type == AccountType.CASH)
        ).all()
    }
    own = own_ibans(session, pid)

    all_txns = session.exec(transactions(pid)).all()
    targets = [
        t for t in all_txns
        if not _is_structural(t, own, cash_ids)
        and (date_from is None or t.booking_date >= date_from)
        and (date_to is None or t.booking_date <= date_to)
    ]

    # Group by full-detail signature so identical rows are classified once.
    groups: dict[str, list[Transaction]] = defaultdict(list)
    for t in targets:
        groups[txn_signature(t)].append(t)

    sigs = list(groups.items())
    if limit is not None:
        sigs = sigs[:limit]

    items: list[tuple[str, str]] = []
    index: dict[str, list[Transaction]] = {}
    for i, (_sig, txns) in enumerate(sigs):
        tid = f"t{i}"
        rep = max(txns, key=lambda t: len((t.reference or "") + (t.description or "")))
        items.append((tid, txn_context(rep, [t.amount for t in txns])))
        index[tid] = txns

    # The LLM must not pick structural categories (transfer / cash_withdrawal):
    # those carry special net-worth / cash-pool semantics and are only set by the
    # structural detector or the manual cash-marking flow. Keep them out of the enum.
    allowed_keys = [k for k in taxonomy.CATEGORY_KEYS if k not in STRUCTURAL_CATEGORIES]
    allowed_labels = {k: v for k, v in taxonomy.LABELS.items() if k not in STRUCTURAL_CATEGORIES}
    results = local_llm.classify_transactions(
        items, allowed_keys, allowed_labels,
        model=model, url=url, batch_size=batch_size, progress=progress,
    )

    # Fallback (deterministic engine) for any group the model didn't return.
    rules = load_rules(session, pid)
    patterns = modules.payment_patterns(session, pid)
    income_keys = {c.key for c in taxonomy.CATEGORIES if c.kind == "income"}

    def _sign_correct(cat: str, amount: Decimal) -> str:
        """A transaction's direction is ground truth: outflows can't be income and
        inflows must be an income_* category (the model occasionally flips these).
        Also defend against a structural category leaking through."""
        if cat == "cash_withdrawal":
            cat = "cash"
        elif cat == "transfer":
            cat = "other"
        if amount > 0 and cat not in income_keys:
            return "income_other"
        if amount < 0 and cat in income_keys:
            return "other"
        return cat

    classified = 0
    fallback = 0
    dist: dict[str, int] = defaultdict(int)
    for tid, txns in index.items():
        res = results.get(tid)
        for t in txns:
            if res is not None:
                t.category = _sign_correct(res["category"], t.amount)
                t.category_source = "llm_full"
            else:
                t.category, _src = engine.categorize(
                    t, own_ibans=own, rules=rules, subscription_keys=set(), patterns=patterns
                )
                t.category_source = "llm_fallback"
            session.add(t)
            dist[t.category] += 1
        classified += len(txns) if res is not None else 0
        fallback += len(txns) if res is None else 0

    return {
        "targets": len(targets),
        "groups": len(sigs),
        "classified_txns": classified,
        "fallback_txns": fallback,
        "distribution": dict(sorted(dist.items(), key=lambda kv: -kv[1])),
        "model": model,
    }
