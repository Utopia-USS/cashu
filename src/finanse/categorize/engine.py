"""The categorization resolver — pure, deterministic, first-match-wins."""

from __future__ import annotations

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
) -> tuple[str, str]:
    """Return (category_key, source) for a transaction.

    source ∈ {transfer, manual, llm, keyword, subscription, default}. A "default"
    source marks an expense we couldn't confidently classify — the LLM pass
    targets exactly those.
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

    # 2. Learned rule (manual correction or cached LLM answer).
    rule = rules.get(mk)
    if rule is not None:
        return rule.category, rule.source

    seed = taxonomy.apply_seed_rules(mk)

    # 3. Income (inflows) — keep separate from expense seeds.
    if txn.amount > 0:
        if seed and seed in _INCOME_KEYS:
            return seed, "keyword"
        if "WYNAGRODZENIE" in mk or "PENSJA" in mk:
            return "income_salary", "keyword"
        return "income_other", "default"

    # 4. Expense: installment/rent phrase anywhere in the text → seed keyword →
    #    recurring signal → uncategorized.
    text = normalize_text(
        " ".join(f for f in (txn.reference, txn.description, txn.counterparty_name) if f)
    )
    phrase = taxonomy.apply_text_rules(text)
    if phrase:
        return phrase, "keyword"
    if seed and seed not in _INCOME_KEYS:
        return seed, "keyword"
    if mk and mk in subscription_keys:
        return "subscriptions", "subscription"
    return "other", "default"
