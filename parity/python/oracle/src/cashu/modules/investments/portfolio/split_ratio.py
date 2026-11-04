"""Exact split ratios: the fraction a split transaction's decimal ``split_ratio`` stands for. Pure."""

from __future__ import annotations

from decimal import Decimal
from fractions import Fraction

SPLIT_RATIO_MAX_DENOMINATOR = 10_000
"""Largest denominator :func:`split_fraction` recovers (a 1:10000 reverse split)."""

SPLIT_RATIO_MIN_EVIDENCE = Fraction(1, 1000)
"""A recovered fraction ``p/q`` needs ``q * q * ulp <= 1/1000`` (``ulp`` = one unit in the last place of
the decimal ratio): the decimal must carry enough digits that matching ``p/q`` is no coincidence
(about a 0.06 % chance for a random decimal)."""


def split_fraction(ratio: Decimal) -> Fraction:
    """The exact new-per-old fraction of a positive, finite split ratio.

    A 1:3 reverse split has no finite decimal, so an importer stores a rounded or truncated value such as
    ``0.3333333333``; scaling lots by that decimal turns 30 shares into 9.999999999 and leaves dust. This
    returns the simple fraction the decimal stands for:

    - a decimal whose exact value has a denominator <= :data:`SPLIT_RATIO_MAX_DENOMINATOR` is exact as
      written (``4``, ``1.5``, ``0.02`` = 1:50, ``0.3333`` = 3333/10000);
    - otherwise the closest ``p/q`` with ``q`` <= :data:`SPLIT_RATIO_MAX_DENOMINATOR` is used when it is
      less than one unit in the last place away (rounded or truncated decimals) and satisfies
      :data:`SPLIT_RATIO_MIN_EVIDENCE` (``0.3333333333`` -> 1/3, ``0.0666666667`` -> 1/15,
      ``0.6666666666`` -> 2/3, ``0.33333333333333333333`` -> 1/3);
    - anything else is used exactly as written (``1.0456723``).

    Trailing zeros carry no precision here (``0.3333333333000`` reads as ``0.3333333333``).
    """
    exact = Fraction(ratio)
    candidate = exact.limit_denominator(SPLIT_RATIO_MAX_DENOMINATOR)
    if candidate == exact:
        return exact
    places = decimal_places(exact)
    if places is None:  # unreachable: a Decimal always has a finite decimal
        return exact
    ulp = Fraction(1, 10**places)
    if abs(candidate - exact) < ulp and candidate.denominator**2 * ulp <= SPLIT_RATIO_MIN_EVIDENCE:
        return candidate
    return exact


def decimal_places(value: Fraction) -> int | None:
    """Places after the point of ``value`` written as a finite decimal (``Fraction(3, 2)`` -> 1, ``5``
    -> 0), or None when it has no finite decimal (``Fraction(1, 3)``)."""
    denominator = value.denominator
    twos = fives = 0
    while denominator % 2 == 0:
        denominator //= 2
        twos += 1
    while denominator % 5 == 0:
        denominator //= 5
        fives += 1
    return max(twos, fives) if denominator == 1 else None
