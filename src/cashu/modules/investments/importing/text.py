"""Text decoding of broker exports: UTF-8 (optional BOM), Windows-1250, or auto-detection."""

from __future__ import annotations

from enum import StrEnum

UTF8_BOM = b"\xef\xbb\xbf"


class ImportTextEncoding(StrEnum):
    """Text encodings broker exports come in (values are the mapping wire names)."""

    UTF8 = "utf-8"
    """UTF-8, with or without a leading byte order mark. Malformed input is an error."""
    WINDOWS_1250 = "windows-1250"
    """Windows-1250 (Central European code page), common in Polish broker exports."""
    AUTO = "auto"
    """UTF-8 when the bytes are valid UTF-8 (or start with a UTF-8 BOM), otherwise Windows-1250."""


_ENCODING_NAMES: dict[str, ImportTextEncoding] = {
    "utf-8": ImportTextEncoding.UTF8,
    "utf8": ImportTextEncoding.UTF8,
    "utf-8-sig": ImportTextEncoding.UTF8,
    "windows-1250": ImportTextEncoding.WINDOWS_1250,
    "windows1250": ImportTextEncoding.WINDOWS_1250,
    "cp1250": ImportTextEncoding.WINDOWS_1250,
    "cp-1250": ImportTextEncoding.WINDOWS_1250,
    "auto": ImportTextEncoding.AUTO,
}

ENCODING_NAMES: tuple[str, ...] = tuple(_ENCODING_NAMES)
"""Every spelling :func:`parse_encoding` accepts."""


def parse_encoding(value: str) -> ImportTextEncoding | None:
    """A mapping value (``utf-8`` / ``utf8``, ``windows-1250`` / ``cp1250``, ``auto``; case-insensitive),
    or None for anything else."""
    return _ENCODING_NAMES.get(value.strip().lower())


def has_utf8_bom(data: bytes) -> bool:
    """Whether ``data`` starts with the UTF-8 byte order mark (EF BB BF)."""
    return data.startswith(UTF8_BOM)


def decode_import_text(data: bytes, encoding: ImportTextEncoding, *, lenient: bool = False) -> str:
    """Decode ``data`` as ``encoding``; a leading UTF-8 BOM is removed.

    With ``lenient`` malformed UTF-8 becomes U+FFFD instead of raising (cheap header sniffing on a
    truncated prefix). Raises ``UnicodeDecodeError`` (a ``ValueError``) for malformed UTF-8 otherwise.
    Windows-1250 never fails: its five undefined bytes (0x81, 0x83, 0x88, 0x90, 0x98) become U+FFFD.
    """
    if encoding == ImportTextEncoding.WINDOWS_1250:
        return _decode_cp1250(data)
    if encoding == ImportTextEncoding.UTF8 or has_utf8_bom(data):
        return _decode_utf8(data, lenient=lenient)
    try:
        return _decode_utf8(data, lenient=False)
    except UnicodeDecodeError:
        return _decode_cp1250(data)


def _decode_utf8(data: bytes, *, lenient: bool) -> str:
    body = data[len(UTF8_BOM) :] if has_utf8_bom(data) else data
    text = body.decode("utf-8", errors="replace" if lenient else "strict")
    # A BOM-less file can still carry U+FEFF as its first character when it was re-encoded.
    return text.removeprefix("﻿")


def _decode_cp1250(data: bytes) -> str:
    return data.decode("cp1250", errors="replace")


__all__ = [
    "ENCODING_NAMES",
    "UTF8_BOM",
    "ImportTextEncoding",
    "decode_import_text",
    "has_utf8_bom",
    "parse_encoding",
]
