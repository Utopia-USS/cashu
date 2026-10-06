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
    # 1. Structural: a move between the user's own accounts, or an FX conversion
    #    to/from the user's own currency accounts — neither is spend/income.
    cp = iban_key(txn.counterparty_iban) if txn.counterparty_iban else ""
    mk = merchant_key(txn.counterparty_name, txn.reference, txn.description)
    if (
        txn.is_internal_transfer
        or (cp and cp in own_ibans)
        or "TRANSAKCJA WALUT" in mk
        or "PRZEWALUTOWANIE" in mk
    ):
        return "transfer", "transfer"

    # 2. Learned rule: a manual (locked) correction wins outright.
    rule = rules.get(mk)
    if rule is not None and rule.locked:
        return rule.category, rule.source

    # 3. A payment a module owns (a loan installment to its lender account or with
    #    its title phrase) is explicit configuration: it beats a cached LLM answer
    #    for the same merchant (possibly learned before the loan was configured).
    text = normalize_text(
        " ".join(f for f in (txn.reference, txn.description, txn.counterparty_name) if f)
    )
    if not txn.amount > 0:
        for p in patterns:
            if (p.counterparty_iban and cp and iban_key(p.counterparty_iban) == cp) or (
                p.text and p.text in text
            ):
                return p.category, "keyword"

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
