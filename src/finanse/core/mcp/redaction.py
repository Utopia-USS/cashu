"""The privacy layer between tool handlers and the agent.

``Redactor(privacy, guard).apply(tree)`` turns a handler's labelled tree into plain JSON:

- ``identifier`` -> the key is dropped (both modes);
- ``amount`` -> dropped in ``strict``, a number in ``amounts``;
- ``merchant`` -> sent, private-person payees as an opaque ``payee:`` reference (``names.NameGuard``);
- ``text`` / ``category`` / ``account`` / ``symbol`` -> scrubbed (``scrub_text``): IBAN-like strings,
  runs of 10+ digits (account / card / phone numbers), e-mail addresses and known person names always;
  money amounts (numbers next to a currency, grouped thousands, decimals, integers of 4+ digits that are
  not years) in ``strict``;
- ``percent`` / ``level`` / ``count`` / ``ref`` / ``flag`` / ``date`` -> type-checked and sent.

A raw (unlabelled) leaf raises :class:`UnlabelledValue`: the call fails closed. After redaction,
``leak_check`` scans the result once more (IBAN-like strings and long digit runs in any mode; in
``strict`` also any number under a money-like key) and raises :class:`LeakDetected` instead of sending.
"""

from __future__ import annotations

import datetime as dt
import json
import re
from decimal import Decimal
from typing import Any

from .labels import Labelled, Sensitivity
from .names import NameGuard

STRICT = "strict"
AMOUNTS = "amounts"


class UnlabelledValue(TypeError):
    """A tool returned a value without a sensitivity label (a bug; nothing is sent)."""


class LeakDetected(RuntimeError):
    """The final check found something that must not leave the machine (nothing is sent)."""


_DROP = object()

# --------------------------------------------------------------------------- #
# Text scrubbing
# --------------------------------------------------------------------------- #

_ISO_DATE = re.compile(
    r"\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b"
)
_PERIOD = re.compile(r"\b\d{4}-(?:0[1-9]|1[0-2]|Q[1-4])\b|\b(?:0[1-9]|1[0-2])/\d{4}\b")
# Account numbers: IBANs (groups split by up to two spaces, dots, slashes, underscores or hyphens),
# runs of 10+ digits (same separators except dots, so amounts stay amounts), dotted 4-digit groups,
# broker account ids (U1234567).
_IBAN = re.compile(
    r"\b[A-Z]{2}\d{2}(?:[ \u00a0._/-]{0,2}[A-Z0-9]{4}){3,8}(?:[ \u00a0._/-]{0,2}[A-Z0-9]{1,4})?\b"
)
_LONG_DIGITS = re.compile(r"(?<!\d)\d(?:[ \u00a0/_-]{0,2}\d){9,}(?!\d)")
_DOTTED_ACCOUNT = re.compile(r"(?<![\d.])\d{2,4}(?:\.\d{4}){3,}(?!\d)")
# a shorter number right after an account word ("konto nr 12345678")
_ACCOUNT_WORD = re.compile(
    r"(?i:\b(?:konto|konta|rachunek|rachunku|account|acct|nr|numer|no)\b\.?[\s:#]{0,3})"
    r"(?:nr\.?\s?)?(\d[\d \u00a0-]{4,}\d)"
)
_ACCOUNT_ID = re.compile(r"\b[A-Z]{1,3}\d{6,9}\b")
_EMAIL = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
# Money: a number next to a currency (any upper-case 3-letter code, Polish / English words, symbols),
# with a multiplier (12 tys., 100k), grouped thousands, decimals, and integers of 4+ digits that are
# not a year in context.
_CUR = (
    r"(?:[A-Z]{3}|(?i:zł|zl|złot\w*|zlot\w*|grosz\w*|euro|eur|usd|pln|gbp|chf|dolar\w*|funt\w*"
    r"|frank\w*)|€|\$|£)"
)
_NUM = r"[-+]?\d(?:[\d \u00a0\u202f'.,]*\d)?"
_MONEY_CUR = re.compile(rf"(?:{_NUM}\s?{_CUR}(?![A-Za-z]))|(?:(?<![A-Za-z]){_CUR}\s?{_NUM})")
_MULTIPLIED = re.compile(
    r"(?<![\w.,])[-+]?\d+(?:[.,]\d+)?\s?(?i:tys\.?|tysi[eę]c\w*|mln|mld|k|m|mn|bn)(?![\w])"
)
_GROUPED = re.compile(
    r"(?<![\w.,])[-+]?\d{1,3}(?:(?:[ \u00a0\u202f']\d{3})+|(?:,\d{3})+|(?:\.\d{3}){2,})(?:[.,]\d+)?"
    r"(?![\w%]|\s?pp\b|\s?%)"
)
_DECIMAL = re.compile(r"(?<![\w.,])[-+]?\d+[.,]\d+(?![\d%]|\s?%|\s?pp\b)")
_BIG_INT = re.compile(r"(?<![\w.,])[-+]?\d{4,}(?![\w%.,]|\s?%|\s?pp\b)")
_MONEY_WORD = re.compile(
    r"(?i:\b(?:price|prices|cena|ceny|cash|amount|kwota|kwoty|value|warto\w*|worth|cost|costs|"
    r"koszt\w*|saldo|balance|deposit\w*|wp[lł]at\w*|wyp[lł]at\w*|fee|fees|tax|prowizj\w*|"
    r"op[lł]at\w*|proceeds|income|expense\w*|przych\w*|wydat\w*|rata|raty|installment)\b"
    r"[^\d\n]{0,24}?)(?<![\w.,])([-+]?\d+(?:[.,]\d+)?)(?![\d%]|[.,]\d|\s?%|\s?pp\b|\s?(?:days?|dni)\b)"
)
_YEAR_BEFORE = re.compile(
    r"(?i:\b(?:in|w|we|rok|roku|year|years|since|od|do|until|from|of|z|za|before|after|przed|po))\s+$"
)
_ISIN = re.compile(r"\b[A-Z]{2}[A-Z0-9]{9}\d\b")
_PLACEHOLDER = "\u0000{}\u0000"


def isin_valid(value: str) -> bool:
    """ISO 6166 check digit (Luhn over the letters-as-numbers expansion)."""
    if not _ISIN.fullmatch(value or ""):
        return False
    digits = "".join(str(int(c, 36)) for c in value[:-1])
    total = 0
    for i, ch in enumerate(reversed(digits)):
        n = int(ch)
        if i % 2 == 0:
            n *= 2
            n = n - 9 if n > 9 else n
        total += n
    return (10 - total % 10) % 10 == int(value[-1])


def _protect_dates(text: str, isins: frozenset[str] = frozenset()) -> tuple[str, list[str]]:
    """Swap ISO dates / timestamps / periods (and the given ISINs) for placeholders, restored after
    scrubbing, so their digits never look like an account number or an amount. ISINs are protected
    only when a symbol field carried them: in free text an ISIN-shaped token (a VAT id, an account
    number that happens to pass the check digit) is scrubbed like any other number."""
    saved: list[str] = []

    def keep(m: re.Match) -> str:
        saved.append(m.group(0))
        return _PLACEHOLDER.format(len(saved) - 1)

    def keep_isin(m: re.Match) -> str:
        return keep(m) if m.group(0) in isins else m.group(0)

    text = _ISO_DATE.sub(keep, text)
    text = _PERIOD.sub(keep, text)
    return (_ISIN.sub(keep_isin, text) if isins else text), saved


def _restore_dates(text: str, saved: list[str]) -> str:
    for i, value in enumerate(saved):
        text = text.replace(_PLACEHOLDER.format(i), value)
    return text


def _big_int(m: re.Match) -> str:
    raw = m.group(0).lstrip("+-")
    if len(raw) == 4 and 1900 <= int(raw) <= 2100:
        before, after = m.string[: m.start()], m.string[m.end() :]
        whole = not before.strip() and not after.strip()
        if whole or _YEAR_BEFORE.search(before) or re.match(r"\s?(?:r\.|rok)", after):
            return m.group(0)  # a year in context
    return "[amount]"


def scrub_text(text: str | None, *, strict: bool, guard: NameGuard | None = None) -> str | None:
    if text is None:
        return None
    text = str(text)
    text, dates = _protect_dates(text)
    text = _IBAN.sub("[iban]", text)
    text = _LONG_DIGITS.sub("[number]", text)
    text = _DOTTED_ACCOUNT.sub("[number]", text)
    text = _ACCOUNT_ID.sub("[account]", text)
    text = _ACCOUNT_WORD.sub(lambda m: m.group(0)[: m.start(1) - m.start(0)] + "[number]", text)
    text = _EMAIL.sub("[email]", text)
    if strict:
        text = _MONEY_CUR.sub("[amount]", text)
        text = _MONEY_WORD.sub(lambda m: m.group(0)[: m.start(1) - m.start(0)] + "[amount]", text)
        text = _MULTIPLIED.sub("[amount]", text)
        text = _GROUPED.sub("[amount]", text)
        text = _DECIMAL.sub("[amount]", text)
        text = _BIG_INT.sub(_big_int, text)
    text = _restore_dates(text, dates)
    if guard is not None:
        if strict:
            text = guard.swap_aliases(text)
        text = guard.mask(text)
    return text


# --------------------------------------------------------------------------- #
# Redactor
# --------------------------------------------------------------------------- #

_KEY = re.compile(r"^[a-z_][a-z0-9_]{0,63}$")
_SYMBOL = re.compile(r"^[A-Z0-9][A-Z0-9.\-:=^_/]{0,19}$")
_REF = re.compile(r"^(?:\d{1,12}|[a-z][a-z0-9_]*:[0-9a-z]{6,64})$")
_DATE_STR = re.compile(r"^\d{4}-\d{2}(?:-\d{2})?(?:[T ][0-9:.+\-Z]+)?$")


def _number(value: Any, path: str) -> float | int | None:
    if value is None:
        return None
    if isinstance(value, bool):
        raise UnlabelledValue(f"{path}: a boolean is not a number")
    if isinstance(value, int):
        return value
    if isinstance(value, (float, Decimal)):
        return float(value)
    raise UnlabelledValue(f"{path}: expected a number, got {type(value).__name__}")


class Redactor:
    def __init__(self, privacy: str, guard: NameGuard | None = None) -> None:
        self.privacy = AMOUNTS if privacy == AMOUNTS else STRICT
        self.strict = self.privacy == STRICT
        self.guard = guard
        self.isins: set[str] = set()

    def text(self, value: str | None) -> str | None:
        return scrub_text(value, strict=self.strict, guard=self.guard)

    def apply(self, tree: Any) -> Any:
        out = self._walk(tree, "$")
        return None if out is _DROP else out

    def _walk(self, node: Any, path: str) -> Any:
        if node is None:
            return None
        if isinstance(node, Labelled):
            return self._leaf(node, path)
        if isinstance(node, dict):
            out: dict[str, Any] = {}
            for key, value in node.items():
                if not isinstance(key, str) or not _KEY.match(key):
                    # Keys are chosen by code (snake_case); data never becomes a key.
                    raise UnlabelledValue(f"{path}: dict keys must be snake_case names")
                item = self._walk(value, f"{path}.{key}")
                if item is not _DROP:
                    out[key] = item
            return out
        if isinstance(node, (list, tuple)):
            items = [self._walk(v, f"{path}[{i}]") for i, v in enumerate(node)]
            return [i for i in items if i is not _DROP]
        raise UnlabelledValue(f"{path}: unlabelled {type(node).__name__}")

    def _leaf(self, node: Labelled, path: str) -> Any:
        label, value = node.label, node.value
        if label is Sensitivity.IDENTIFIER:
            return _DROP
        if label is Sensitivity.AMOUNT:
            return _DROP if self.strict else _number(value, path)
        if value is None:
            return None
        if label in (Sensitivity.PERCENT, Sensitivity.LEVEL):
            return _number(value, path)
        if label is Sensitivity.COUNT:
            if isinstance(value, bool) or not isinstance(value, int):
                raise UnlabelledValue(f"{path}: a count must be an integer")
            return value
        if label is Sensitivity.FLAG:
            if not isinstance(value, bool):
                raise UnlabelledValue(f"{path}: a flag must be a boolean")
            return value
        if label is Sensitivity.DATE:
            if isinstance(value, (dt.date, dt.datetime)):
                return value.isoformat()
            if isinstance(value, str) and _DATE_STR.match(value):
                return value
            raise UnlabelledValue(f"{path}: not a date")
        if label is Sensitivity.REF:
            ref = str(value)
            if not _REF.match(ref):
                raise UnlabelledValue(f"{path}: not a reference")
            return value if isinstance(value, int) and not isinstance(value, bool) else ref
        if label is Sensitivity.MERCHANT:
            merchant = str(value)
            if self.guard is not None:
                merchant = self.guard.merchant(merchant)
            return self.text(merchant) if not merchant.startswith("payee:") else merchant
        if label is Sensitivity.SYMBOL:
            symbol = str(value)
            if isin_valid(symbol):
                self.isins.add(symbol)  # the leak check lets exactly these through
                return symbol
            if _SYMBOL.match(symbol) and not (symbol.isdigit() and len(symbol) >= 5):
                # a ticker-like token: identifiers and known names are still scrubbed
                return scrub_text(symbol, strict=False, guard=self.guard)
            return self.text(symbol)
        if label in (Sensitivity.TEXT, Sensitivity.CATEGORY, Sensitivity.ACCOUNT):
            return self.text(str(value))
        raise UnlabelledValue(f"{path}: unknown label {label}")  # pragma: no cover


# --------------------------------------------------------------------------- #
# Final check
# --------------------------------------------------------------------------- #

# Keys whose numbers are money or quantities: in strict mode none may carry a number.
MONEY_KEYS = frozenset(
    {
        "amount",
        "amounts",
        "value",
        "values",
        "total",
        "totals",
        "cost",
        "price",
        "quantity",
        "balance",
        "income",
        "expense",
        "expenses",
        "net",
        "outstanding",
        "principal",
        "payment",
        "monthly_payment",
        "cash",
        "market_value",
        "gross",
        "gross_amount",
        "cash_amount",
        "fee",
        "tax",
        "installment",
        "typical_amount",
        "assets",
        "liabilities",
        "realized",
        "unrealized",
        "to_target",
        "monthly_amount",
        "min_trade_value",
        "unit_value",
    }
)


def leak_check(
    result: Any, *, strict: bool, isins: frozenset[str] | set[str] = frozenset()
) -> None:
    """Raise :class:`LeakDetected` when the redacted ``result`` still holds an identifier-like
    string, or (strict) a number under a money key. ``isins``: the ISINs symbol fields carried
    (``Redactor.isins``), the only digit runs of that shape allowed through."""
    blob, _dates = _protect_dates(json.dumps(result, ensure_ascii=False), frozenset(isins))
    if _IBAN.search(blob) or _LONG_DIGITS.search(blob) or _DOTTED_ACCOUNT.search(blob):
        raise LeakDetected("identifier-like value in the response")
    if strict:
        _check_money_keys(result, "$")


def _check_money_keys(node: Any, path: str) -> None:
    if isinstance(node, dict):
        for key, value in node.items():
            if (
                key in MONEY_KEYS
                and isinstance(value, (int, float))
                and not isinstance(value, bool)
            ):
                raise LeakDetected(f"number under the money key {path}.{key} in strict mode")
            _check_money_keys(value, f"{path}.{key}")
    elif isinstance(node, list):
        for i, value in enumerate(node):
            _check_money_keys(value, f"{path}[{i}]")
