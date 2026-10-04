"""Learned merchant→category rules (the categorization "model")."""

from __future__ import annotations

from sqlmodel import Session, select

from ..models import CategoryRule


def load_rules(session: Session) -> dict[str, CategoryRule]:
    """merchant_key -> rule, for fast lookup during categorization."""
    return {r.merchant_key: r for r in session.exec(select(CategoryRule)).all()}


def upsert_rule(
    session: Session,
    merchant_key: str,
    category: str,
    *,
    source: str = "manual",
    locked: bool | None = None,
) -> CategoryRule:
    """Create/update a merchant rule.

    Manual corrections are locked and are never overwritten by later LLM guesses.
    """
    if locked is None:
        locked = source == "manual"
    existing = session.exec(
        select(CategoryRule).where(CategoryRule.merchant_key == merchant_key)
    ).first()
    if existing is not None:
        if existing.locked and source != "manual":
            return existing  # don't let an LLM guess clobber a human decision
        existing.category = category
        existing.source = source
        existing.locked = locked
        session.add(existing)
        return existing
    rule = CategoryRule(merchant_key=merchant_key, category=category, source=source, locked=locked)
    session.add(rule)
    return rule
