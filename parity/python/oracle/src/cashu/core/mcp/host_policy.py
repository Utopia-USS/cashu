"""TRANSITIONAL(S38f): additive native name sources for the local Python MCP bridge.

This adapter only adds masking. It never imports replacement targets, symbol exemptions, profile
identities or secrets. Existing S37 matching and redaction algorithms remain in ``names``.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from .names import NameGuard, _name_terms, fold, normalize

_FIELDS = {"persons", "strongNames", "privatePayees", "strictNames"}
_MAX_ITEMS = 4096
_MAX_CODEPOINTS = 2048
_MAX_UTF8_BYTES = 1024 * 1024


class InvalidNameGuard(ValueError):
    """The private bridge payload is malformed or exceeds its fixed bounds."""


@dataclass(frozen=True)
class NativeGuardSources:
    persons: tuple[str, ...]
    strong_names: tuple[str, ...]
    private_payees: tuple[str, ...]
    strict_names: tuple[str, ...]


def parse_guard_sources(value: object) -> NativeGuardSources:
    """Validate the whole payload, never truncate it or include its contents in an error."""
    if not isinstance(value, dict) or set(value) != _FIELDS:
        raise InvalidNameGuard("invalid host name guard")
    item_count = byte_count = 0
    fields: dict[str, tuple[str, ...]] = {}
    for key in _FIELDS:
        values = value[key]
        if not isinstance(values, list):
            raise InvalidNameGuard("invalid host name guard")
        item_count += len(values)
        if item_count > _MAX_ITEMS:
            raise InvalidNameGuard("invalid host name guard")
        for item in values:
            if not isinstance(item, str) or len(item) > _MAX_CODEPOINTS:
                raise InvalidNameGuard("invalid host name guard")
            try:
                byte_count += len(item.encode("utf-8"))
            except UnicodeEncodeError:
                raise InvalidNameGuard("invalid host name guard") from None
            if byte_count > _MAX_UTF8_BYTES:
                raise InvalidNameGuard("invalid host name guard")
        fields[key] = tuple(values)
    return NativeGuardSources(
        fields["persons"], fields["strongNames"], fields["privatePayees"], fields["strictNames"]
    )


class _AdditiveGuard(NameGuard):
    def __init__(self, baseline: NameGuard, extra: NameGuard) -> None:
        def conflicts(value: str) -> bool:
            return extra.is_private(value) or extra.mask(value) != value

        super().__init__(
            profile_id=baseline.profile_id,
            names=baseline.names,
            private_payees=baseline.private_payees | extra.private_payees,
            _secret=baseline._secret,
            # A stale public replacement or numeric exemption must not bypass a native restriction.
            strict_aliases=tuple(
                (origin, "[name]" if conflicts(origin) else target)
                for origin, target in baseline.strict_aliases
            ),
            symbols=frozenset(symbol for symbol in baseline.symbols if not conflicts(symbol)),
        )
        self._extra = extra

    def is_private(self, merchant: str) -> bool:
        return super().is_private(merchant) or self._extra.is_private(merchant)

    def swap_aliases(self, text: str) -> str:
        baseline = super().swap_aliases(text)
        # Substitution runs before mask and can split an incoming private name (Anna -> a
        # public fund inside Anna-Li). Preserve both restrictions on the original whole field.
        if baseline != text and self._extra.mask(text) != text:
            return "[name]"
        return baseline

    def mask(self, text: str) -> str:
        # A union changes S37's overlap selection, while sequential passes can lose a private
        # phrase or glued name after the first pass masks only part of it. Compare independent
        # applications to the original text; conflicting masks conservatively hide that string.
        baseline = super().mask(text)
        extra = self._extra.mask(text)
        if baseline == text:
            return extra
        if extra == text or baseline == extra:
            return baseline
        return "[name]"


def augment_guard(baseline: NameGuard, sources: NativeGuardSources, *, strict: bool) -> NameGuard:
    raw = sources.persons + sources.strong_names + sources.private_payees
    if strict:
        raw += sources.strict_names
    terms: set[str] = set()
    for value in raw:
        if value.strip():
            # Exact terms also cover short/numeric private aliases excluded by person heuristics.
            # Token expansion is deliberately conservative in divergent native/Python states.
            terms.add(fold(value.strip()))
            terms.update(_name_terms(value, tokens=True))
            # A Python mask can split an incoming phrase. Cover its remaining short/numeric
            # words too, so that composition cannot reveal the rest of that private phrase.
            terms.update(re.findall(r"[\w'-]+", fold(value)))
    extra = NameGuard(
        profile_id=baseline.profile_id,
        names=frozenset(terms),
        private_payees=frozenset(
            normalize(value) for value in sources.private_payees if value.strip()
        ),
    )
    return _AdditiveGuard(baseline, extra)
