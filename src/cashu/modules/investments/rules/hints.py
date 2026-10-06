"""Did-you-mean hints for unknown keys, values and expression names."""

from __future__ import annotations

from collections.abc import Iterable


def closest_match(text: str, candidates: Iterable[str]) -> str | None:
    """The candidate closest to ``text``, or None when nothing is close enough to be a plausible typo.

    Uses the optimal string alignment distance (a swap of two neighbouring letters counts as one edit),
    case-insensitively. Allowed distance: 1 for up to 4 characters, 2 for up to 8, else 3.
    """
    needle = text.lower()
    max_distance = 1 if len(needle) <= 4 else (2 if len(needle) <= 8 else 3)
    best: str | None = None
    best_distance = max_distance + 1
    for candidate in candidates:
        distance = _edit_distance(needle, candidate.lower())
        if distance < best_distance:
            best = candidate
            best_distance = distance
    return best


def did_you_mean(text: str, candidates: Iterable[str]) -> str:
    """`` (did you mean "x"?)`` for the :func:`closest_match` of ``text``, or an empty string."""
    match = closest_match(text, candidates)
    return "" if match is None else f' (did you mean "{match}"?)'


def _edit_distance(a: str, b: str) -> int:
    if a == b:
        return 0
    # Inputs are short (keys, names); bail out early on absurd lengths to keep this O(small).
    if abs(len(a) - len(b)) > 3 or len(a) > 64 or len(b) > 64:
        return 99
    rows = [[0] * (len(b) + 1) for _ in range(len(a) + 1)]
    for i in range(len(a) + 1):
        rows[i][0] = i
    for j in range(len(b) + 1):
        rows[0][j] = j
    for i in range(1, len(a) + 1):
        for j in range(1, len(b) + 1):
            cost = 0 if a[i - 1] == b[j - 1] else 1
            best = min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost)
            if i > 1 and j > 1 and a[i - 1] == b[j - 2] and a[i - 2] == b[j - 1]:
                best = min(best, rows[i - 2][j - 2] + 1)
            rows[i][j] = best
    return rows[len(a)][len(b)]
