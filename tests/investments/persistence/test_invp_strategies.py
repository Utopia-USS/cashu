"""The Strategie tab's endpoints (docs/agents/strategies.md stage 1): main first (listed even when
missing), one-file and folder strategies from ``strategies/``, frontmatter / heading titles, and reads
limited to the listed files of one strategy. Synthetic text only."""

from __future__ import annotations

import os

import pytest
from invp_support import STRATEGY_YAML

from cashu.modules.investments.service import files, strategy_docs


@pytest.fixture
def slug(api_empty) -> str:
    r = api_empty.post("/api/profiles", json={"name": "Jan Strateg", "modules": ["investments"]})
    assert r.status_code == 201, r.text
    return r.json()["slug"]


def listed(client, slug: str) -> dict[str, dict]:
    r = client.get(f"/api/p/{slug}/investments/strategies")
    assert r.status_code == 200, r.text
    return {s["id"]: s for s in r.json()["strategies"]}


def test_main_is_listed_even_without_files(api_empty, slug):
    items = listed(api_empty, slug)
    assert list(items) == [strategy_docs.MAIN_ID]
    main = items[strategy_docs.MAIN_ID]
    assert main["main"] and main["executed"] and main["files"] == [] and main["title"] is None
    assert main["brief"]["state"] == "missing"


def test_main_and_folder_strategies(api_empty, slug):
    files.write_text_private(files.strategy_yaml_path(slug), STRATEGY_YAML)
    files.write_text_private(files.strategy_md_path(slug), "# Rdzeń ETF\n\nKupuję co miesiąc.\n")
    sdir = strategy_docs.strategies_dir(slug)
    (sdir / "swing" / "zrodla").mkdir(parents=True)
    (sdir / "swing" / "README.md").write_text("---\ntitle: Swing z sygnałów\nstatus: test\n---\n# Inny\n")
    (sdir / "swing" / "rules.yaml").write_text("rules: []\n")
    (sdir / "swing" / "zrodla" / "telegram.md").write_text("Kanał: przykładowy\n")
    (sdir / "swing" / ".hidden.md").write_text("x")
    (sdir / "swing" / "image.png").write_bytes(b"\x89PNG")
    (sdir / "uznaniowa.md").write_text("Bez nagłówka.\n")
    (sdir / "uznaniowa.yaml").write_text("review: {}\n")
    (sdir / "Bad Name.md").write_text("pominięta\n")

    items = listed(api_empty, slug)
    assert list(items) == [strategy_docs.MAIN_ID, "swing", "uznaniowa"]
    main = items[strategy_docs.MAIN_ID]
    assert main["title"] == "Rdzeń ETF" and main["main_file"] == "strategy.md"
    assert [f["path"] for f in main["files"]] == ["strategy.md", "strategy.yaml"]
    assert main["brief"]["state"] == "valid"

    swing = items["swing"]
    assert swing["title"] == "Swing z sygnałów" and swing["status"] == "test" and not swing["executed"]
    assert swing["main_file"] == "README.md"
    assert {f["path"]: f["kind"] for f in swing["files"]} == {
        "README.md": "md", "rules.yaml": "yaml", "zrodla/telegram.md": "md",
    }
    one = items["uznaniowa"]
    assert one["title"] == "uznaniowa" and [f["path"] for f in one["files"]] == ["uznaniowa.md", "uznaniowa.yaml"]

    r = api_empty.get(f"/api/p/{slug}/investments/strategies/swing/file", params={"path": "zrodla/telegram.md"})
    assert r.status_code == 200 and r.json()["text"] == "Kanał: przykładowy\n"


@pytest.mark.parametrize(
    ("strategy_id", "path"),
    [
        ("swing", "../uznaniowa.md"),  # another strategy's file
        ("uznaniowa", "swing/README.md"),  # a one-file strategy sees only its own files
        (strategy_docs.MAIN_ID, "../../secret.md"),
        (strategy_docs.MAIN_ID, "swing.md"),
        ("swing", ".hidden.md"),
        ("nope", "README.md"),
    ],
)
def test_reads_are_limited_to_listed_files(api_empty, slug, strategy_id, path):
    sdir = strategy_docs.strategies_dir(slug)
    (sdir / "swing").mkdir(parents=True)
    (sdir / "swing" / "README.md").write_text("# Swing\n")
    (sdir / "swing" / ".hidden.md").write_text("x")
    (sdir / "uznaniowa.md").write_text("# U\n")
    r = api_empty.get(f"/api/p/{slug}/investments/strategies/{strategy_id}/file", params={"path": path})
    assert r.status_code == 404, r.text


def test_symlinks_are_not_followed(api_empty, slug, tmp_path):
    outside = tmp_path / "outside.md"
    outside.write_text("# poza profilem\n")
    sdir = strategy_docs.strategies_dir(slug)
    (sdir / "swing").mkdir(parents=True)
    os.symlink(outside, sdir / "swing" / "link.md")
    os.symlink(tmp_path, sdir / "linked")
    items = listed(api_empty, slug)
    assert "linked" not in items and items["swing"]["files"] == []


def test_frontmatter_ignores_broken_blocks():
    assert strategy_docs.frontmatter("---\ntitle: [\n---\n# A\n") == ({}, "---\ntitle: [\n---\n# A\n")
    meta, body = strategy_docs.frontmatter("---\ntitle: X\nlist: [1]\n---\n# A\n")
    assert meta == {"title": "X"} and body == "# A\n"
