#!/usr/bin/env python3
"""Sign a built cashU.app archive for Sparkle and write its update feed (appcast).

    python3 scripts/make_appcast.py build/macos/cashU-<version>-macos-<arch>.zip

Run after ``scripts/build_macos.sh`` with ``SPARKLE_PUBLIC_ED_KEY`` set. It

1. reads the version, minimum macOS and update key from the built app's Info.plist
   (``<build>/dist/cashU.app``) and checks that the archive name carries the same version;
2. signs the archive with Sparkle's ``sign_update`` (``<build>/sparkle/bin``), which takes the private
   key from the login keychain (``generate_keys`` put it there) or from ``--ed-key-file``;
3. verifies that signature against the app's ``SUPublicEDKey``, so a release signed with another key
   (one the installed apps would reject forever) is never written;
4. writes ``appcast-macos-<arch>.xml`` next to the archive: one item, the archive's download URL in the
   GitHub release ``v<version>``.

Upload the archive and the feed to that release (packaging/README.md, "Auto-update"). The feed URL in
the app points at ``releases/latest/download/``, so the newest release is what every app sees.
Standard library only, except ``cryptography`` for the check (a dependency of cashU itself).
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import email.utils
import plistlib
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from xml.sax.saxutils import escape, quoteattr

DEFAULT_REPO = "Utopia-USS/cashu"
SPARKLE_NS = "http://www.andymatuschak.org/xml-namespaces/sparkle"
SPARKLE_MIN_MACOS = "12.0"  # Sparkle 2.10
_ARCHIVE = re.compile(r"^cashU-(?P<version>[^-]+)-macos-(?P<arch>[a-z0-9_]+)\.zip$")
_SIGNATURE = re.compile(r'sparkle:edSignature="(?P<sig>[^"]+)"\s+length="(?P<length>\d+)"')


class AppcastError(RuntimeError):
    pass


@dataclass(frozen=True)
class Release:
    version: str  # CFBundleShortVersionString
    build: str  # CFBundleVersion, what Sparkle compares
    min_macos: str
    url: str
    length: int
    signature: str
    notes_url: str
    published: dt.datetime


def parse_archive_name(name: str) -> tuple[str, str]:
    """``cashU-<version>-macos-<arch>.zip`` -> (version, arch)."""
    m = _ARCHIVE.match(name)
    if not m:
        raise AppcastError(f"not a cashU archive name: {name} (cashU-<version>-macos-<arch>.zip)")
    return m.group("version"), m.group("arch")


def parse_sign_update(output: str) -> tuple[str, int]:
    """The ``sparkle:edSignature="..." length="..."`` line of ``sign_update``."""
    m = _SIGNATURE.search(output)
    if not m:
        raise AppcastError("sign_update printed no signature")
    return m.group("sig"), int(m.group("length"))


def verify(data: bytes, signature: str, public_key: str) -> bool:
    """The EdDSA (Ed25519) signature Sparkle checks before it installs an update."""
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

    try:
        key = Ed25519PublicKey.from_public_bytes(base64.b64decode(public_key, validate=True))
        key.verify(base64.b64decode(signature, validate=True), data)
    except (InvalidSignature, ValueError):
        return False
    return True


def min_macos(app_minimum: str | None) -> str:
    """The app's own minimum, never below Sparkle's."""
    if not app_minimum:
        return SPARKLE_MIN_MACOS

    def key(v: str) -> tuple[int, ...]:
        return tuple(int(p) for p in v.split(".") if p.isdigit())

    return max(app_minimum, SPARKLE_MIN_MACOS, key=key)


def appcast_xml(release: Release) -> str:
    item = [
        f"      <title>{escape(f'cashU {release.version}')}</title>",
        f"      <pubDate>{email.utils.format_datetime(release.published)}</pubDate>",
        f"      <link>{escape(release.notes_url)}</link>",
        f"      <sparkle:version>{escape(release.build)}</sparkle:version>",
        f"      <sparkle:shortVersionString>{escape(release.version)}</sparkle:shortVersionString>",
        f"      <sparkle:minimumSystemVersion>{escape(release.min_macos)}</sparkle:minimumSystemVersion>",
        (
            f"      <enclosure url={quoteattr(release.url)} length=\"{release.length}\""
            f" type=\"application/octet-stream\" sparkle:edSignature={quoteattr(release.signature)}/>"
        ),
    ]
    return "\n".join(
        [
            '<?xml version="1.0" encoding="utf-8"?>',
            f'<rss version="2.0" xmlns:sparkle="{SPARKLE_NS}">',
            "  <channel>",
            "    <title>cashU</title>",
            "    <item>",
            *item,
            "    </item>",
            "  </channel>",
            "</rss>",
            "",
        ]
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("archive", type=Path, help="cashU-<version>-macos-<arch>.zip")
    parser.add_argument("--app", type=Path, help="the built app (default: <build>/dist/cashU.app)")
    parser.add_argument("--sign-update", type=Path, help="default: <build>/sparkle/bin/sign_update")
    parser.add_argument("--ed-key-file", type=Path, help="private key file instead of the keychain")
    parser.add_argument("--repo", default=DEFAULT_REPO, help=f"GitHub repo (default {DEFAULT_REPO})")
    parser.add_argument(
        "--download-base", help="where the archive is downloaded from (default: the GitHub release)"
    )
    parser.add_argument("--out", type=Path, help="default: appcast-macos-<arch>.xml next to it")
    args = parser.parse_args(argv)

    try:
        archive: Path = args.archive.resolve()
        build = archive.parent
        version, arch = parse_archive_name(archive.name)
        app = args.app or build / "dist" / "cashU.app"
        info = plistlib.loads((app / "Contents" / "Info.plist").read_bytes())
        if info.get("CFBundleShortVersionString") != version:
            raise AppcastError(f"{app} is version {info.get('CFBundleShortVersionString')}, "
                               f"the archive {version}")
        public_key = info.get("SUPublicEDKey")
        if not public_key or not info.get("SUFeedURL"):
            raise AppcastError(f"{app} has no update feed (build with SPARKLE_PUBLIC_ED_KEY)")

        tool = args.sign_update or build / "sparkle" / "bin" / "sign_update"
        cmd = [str(tool), str(archive)]
        if args.ed_key_file:
            cmd[1:1] = ["--ed-key-file", str(args.ed_key_file)]
        done = subprocess.run(cmd, capture_output=True, text=True, check=False)
        if done.returncode != 0:
            raise AppcastError(f"sign_update failed: {done.stderr.strip() or done.stdout.strip()}")
        signature, length = parse_sign_update(done.stdout)
        data = archive.read_bytes()
        if length != len(data):
            raise AppcastError("sign_update reported another length than the archive has")
        if not verify(data, signature, public_key):
            raise AppcastError("the signature does not match the app's SUPublicEDKey: wrong key")

        tag = f"v{version}"
        base = args.download_base or f"https://github.com/{args.repo}/releases/download/{tag}"
        release = Release(
            version=version,
            build=str(info.get("CFBundleVersion") or version),
            min_macos=min_macos(info.get("LSMinimumSystemVersion")),
            url=f"{base.rstrip('/')}/{archive.name}",
            length=length,
            signature=signature,
            notes_url=f"https://github.com/{args.repo}/releases/tag/{tag}",
            published=dt.datetime.now(dt.UTC).replace(microsecond=0),
        )
        out = args.out or build / f"appcast-macos-{arch}.xml"
        out.write_text(appcast_xml(release), encoding="utf-8")
    except (AppcastError, OSError, plistlib.InvalidFileException) as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    print(f"feed:    {out}")
    print(f"release: gh release create {tag} {archive} {out} --repo {args.repo}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
