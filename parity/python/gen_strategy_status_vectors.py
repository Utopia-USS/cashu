"""Actual Python strategy_status on invented in-memory profiles and isolated strategy files."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import tempfile
from pathlib import Path

from gen_alert_view_vectors import formatted

REPO = Path(__file__).resolve().parents[2]
TARGET = REPO / "packages/parity/src/producers/investments/fixtures/strategy-status.json"

VALID = """version: 1
base_currency: EUR
horizon_years: 10
buckets:
  - id: synthetic
    match: {asset_class: equity, tags: [quality]}
allocation:
  targets: {synthetic: 1.0}
contributions: {monthly_amount: 125.50, day_of_month: 12}
rules: []
"""


def generate(root: Path) -> list[dict]:
    root = root.resolve()
    os.environ.update(
        CASHU_DATA_DIR=str(root / "data"),
        HOME=str(root),
        CASHU_TESTING="1",
        CASHU_WORKSPACES_DIR=str(root / "workspaces"),
        CASHU_AUTO_DAILY="0",
        TZ="Europe/Warsaw",
    )
    import canon
    import frozen
    import golden
    from sqlmodel import Session, SQLModel, create_engine

    golden.import_all()
    frozen.install("2026-10-01T12:00:00")
    from cashu.core.i18n import use_language
    from cashu.core.models import Profile
    from cashu.modules.investments.service import files, strategy
    from cashu.modules.investments.service.views import strategy_status

    engine = create_engine("sqlite://")
    SQLModel.metadata.create_all(engine)
    cases = [
        ("missing", None),
        ("valid", VALID),
        (
            "partial",
            VALID.replace("rules: []", "rules:\n  - id: broken\n    kind: unknown_synthetic_kind"),
        ),
        ("invalid", "version: [unterminated"),
    ]
    out = []
    for index, (name, yaml) in enumerate(cases, 1):
        with Session(engine) as session, use_language("en"):
            profile = Profile(
                id=index,
                slug=f"synthetic-status-{index}",
                name=f"Synthetic {index}",
                base_currency="PLN",
                created_at=dt.datetime(2026, 9, 1, tzinfo=dt.UTC),
            )
            session.add(profile)
            session.commit()
            if yaml is not None:
                files.write_text_private(files.strategy_yaml_path(profile.slug), yaml)
                files.write_text_private(
                    files.strategy_md_path(profile.slug), "Synthetic strategy prose"
                )
                strategy.load(session, profile, record=True)
                session.commit()
            canon.PATH_ALIASES[:] = [(str(root / "data"), "$DATA_DIR")]
            expected = canon.Canon(None).value(strategy_status(session, profile))
            versions = strategy.versions(session, profile.id)
            out.append(
                {
                    "name": name,
                    "slug": profile.slug,
                    "yaml": yaml,
                    "md": None if yaml is None else "Synthetic strategy prose",
                    "versions": [
                        {
                            "version": row.version,
                            "state": row.state,
                            "createdAt": row.created_at.isoformat(),
                            "sha256": row.sha256,
                            "issues": row.issues,
                        }
                        for row in versions
                    ],
                    "expected": expected,
                }
            )
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="cashu-strategy-status-") as temporary:
        result = generate(Path(temporary))
        output = formatted(
            json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2) + "\n", TARGET
        )
    if args.check:
        ok = TARGET.exists() and TARGET.read_text() == output
        print(f"strategy-status: {'pass' if ok else 'stale'}")
        return 0 if ok else 1
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    TARGET.write_text(output)
    print("strategy-status: generated")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
