"""Text and account-number normalization shared by every module.

Account matching (core) and transaction matching (budget) must agree on how an
IBAN or a piece of bank text is canonicalized, so the helpers live here.
"""

from __future__ import annotations

import re
import unicodedata

_WS = re.compile(r"\s+")


def normalize_text(value: str | None) -> str:
    """Uppercase, strip diacritics, collapse whitespace — for stable matching."""
    if not value:
        return ""
    # strip accents (ł -> l is not handled by NFKD, so special-case it)
    value = value.replace("ł", "l").replace("Ł", "L")
    value = unicodedata.normalize("NFKD", value)
    value = "".join(c for c in value if not unicodedata.combining(c))
    return _WS.sub(" ", value).strip().upper()


def normalize_iban(value: str | None) -> str:
    """Strip spaces, apostrophes and any punctuation (bank exports guard account
    numbers with a leading `'` for Excel), leaving only alphanumerics, uppercased."""
    if not value:
        return ""
    return re.sub(r"[^0-9A-Za-z]", "", value).upper()


def iban_key(value: str | None) -> str:
    """Canonical account key for matching across sources.

    Polish CSV exports give the bare 26-digit NRB (``02114...``) while Open
    Banking returns the full IBAN with a country prefix (``PL02114...``). Strip a
    leading 2-letter country code so both forms compare equal.
    """
    s = normalize_iban(value)
    if len(s) > 2 and s[:2].isalpha():
        s = s[2:]
    return s
