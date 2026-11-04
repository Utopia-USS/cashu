"""File uploads of the local API: a size-capped request body and a stdlib multipart parser.

``python-multipart`` is not a dependency, so ``multipart/form-data`` is parsed with the email parser.
Modules use these for their import previews (budget statements); the investments module keeps its own
copy from before this helper existed.
"""

from __future__ import annotations

from email import policy
from email.parser import BytesParser

from fastapi import HTTPException, Request

TOO_LARGE_CODE = "file_too_large"


def too_large() -> HTTPException:
    return HTTPException(
        status_code=413, detail="File too large", headers={"X-Cashu-Error-Code": TOO_LARGE_CODE}
    )


async def read_limited(request: Request, limit: int) -> bytes:
    """The request body, refused (413 ``file_too_large``) as soon as it is larger than ``limit``: a
    declared Content-Length is checked before reading, and the stream is counted while it arrives (a
    missing or false Content-Length never makes the server buffer more than ``limit`` bytes)."""
    declared = request.headers.get("content-length")
    if declared is not None:
        try:
            size = int(declared)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid Content-Length") from None
        if size > limit:
            raise too_large()
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > limit:
            raise too_large()
        chunks.append(chunk)
    return b"".join(chunks)


def parse_multipart(content_type: str, body: bytes) -> dict[str, tuple[str | None, bytes]]:
    """``multipart/form-data`` fields -> {name: (filename, bytes)}; ValueError when malformed."""
    head = f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode("latin-1")
    message = BytesParser(policy=policy.HTTP).parsebytes(head + body)
    if not message.is_multipart():
        raise ValueError("Malformed multipart body")
    out: dict[str, tuple[str | None, bytes]] = {}
    for part in message.iter_parts():
        name = part.get_param("name", header="content-disposition")
        if not name:
            continue
        out[str(name)] = (part.get_filename(), part.get_payload(decode=True) or b"")
    return out


def text_field(fields: dict[str, tuple[str | None, bytes]], name: str) -> str | None:
    """A text field of a parsed multipart body (stripped; None when absent or blank)."""
    value = fields.get(name)
    if value is None:
        return None
    text = value[1].decode("utf-8", errors="replace").strip()
    return text or None
