"""The categorization resolver — pure, deterministic, first-match-wins."""

from __future__ import annotations

from collections.abc import Sequence

from cashu.core.modules import PaymentPattern

from ..ingestion.normalize import iban_key, merchant_key, normalize_text
from ..models import CategoryRule, Transaction
from . import taxonomy

_INCOME_KEYS = {c.key for c in taxonomy.CATEGORIES if c.kind == "income"}


def categorize(
    txn: Transaction,
    *,
    own_ibans: set[str],
    rules: dict[str, CategoryRule],
    subscription_keys: set[str],
    patterns: Sequence[PaymentPattern] = (),
) -> tuple[str, str]:
    """Return (category_key, source) for a transaction.

    source ∈ {transfer, manual, llm, keyword, subscription, default}. A "default"
    source marks an expense we couldn't confidently classify — the LLM pass
    targets exactly those. ``patterns``: payments other modules own (e.g. a loan's
    lender account or title phrase), checked for outflows before cached LLM rules
    and the phrase and seed rules; only a manual (locked) merchant rule beats them.
    """
    # 1-3. Structural, the owner's locked merchant rule, a loan's payment pattern.
    decided = owner_decision(txn, own_ibans=own_ibans, rules=rules, patterns=patterns)
    if decided is not None:
        return decided
    mk = merchant_key(txn.counterparty_name, txn.reference, txn.description)
    rule = rules.get(mk)
    text = _text(txn)

    # 4. Cached LLM answer for the merchant.
    if rule is not None:
        return rule.category, rule.source

    seed = taxonomy.apply_seed_rules(mk)

    # 5. Income (inflows) - keep separate from expense seeds.
    if txn.amount > 0:
        if seed and seed in _INCOME_KEYS:
            return seed, "keyword"
        if "WYNAGRODZENIE" in mk or "PENSJA" in mk:
            return "income_salary", "keyword"
        return "income_other", "default"

    # 6. Expense: installment/rent phrase anywhere in the text → seed keyword →
    #    recurring signal → uncategorized.
    phrase = taxonomy.apply_text_rules(text)
    if phrase:
        return phrase, "keyword"
    if seed and seed not in _INCOME_KEYS:
        return seed, "keyword"
    if mk and mk in subscription_keys:
        return "subscriptions", "subscription"
    return "other", "default"


def _text(txn: Transaction) -> str:
    return normalize_text(
        " ".join(f for f in (txn.reference, txn.description, txn.counterparty_name) if f)
    )


def _pattern_match(
    txn: Transaction, cp: str, text: str, patterns: Sequence[PaymentPattern]
) -> str | None:
    """The category of the first module payment pattern an outflow matches."""
    if txn.amount > 0:
        return None
    for p in patterns:
        if (p.counterparty_iban and cp and iban_key(p.counterparty_iban) == cp) or (
            p.text and p.text in text
        ):
            return p.category
    return None


def owner_decision(
    txn: Transaction,
    *,
    own_ibans: set[str],
    rules: dict[str, CategoryRule],
    patterns: Sequence[PaymentPattern] = (),
) -> tuple[str, str] | None:
    """(category, source) when structure or the owner's configuration decides the
    transaction, else None. The first steps of ``categorize``, in its order:

    1. structural: a move between the owner's own accounts or an FX conversion
       ("transfer"), never spend or income;
    2. the owner's locked (manual) merchant rule;
    3. the owner's per-loan payment pattern (lender account or title phrase): it beats
       a cached LLM answer for the same merchant (possibly learned before the loan
       was configured).

    An LLM pass never overrides these, and they still apply to rows an earlier LLM
    pass categorized. Global phrases (installment phrases, seed rules) are not owner
    configuration and do not override an LLM answer."""
    cp = iban_key(txn.counterparty_iban) if txn.counterparty_iban else ""
    mk = merchant_key(txn.counterparty_name, txn.reference, txn.description)
    if (
        txn.is_internal_transfer
        or (cp and cp in own_ibans)
        or "TRANSAKCJA WALUT" in mk
        or "PRZEWALUTOWANIE" in mk
    ):
        return "transfer", "transfer"
    rule = rules.get(mk)
    if rule is not None and rule.locked:
        return rule.category, rule.source
    hit = _pattern_match(txn, cp, _text(txn), patterns)
    if hit is not None:
        return hit, "keyword"
    return None
