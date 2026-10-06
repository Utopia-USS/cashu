"""Per-profile agent workspace (core/workspace): create, update, status, API, CLI, profile isolation.

Every path is under tmp_path: the workspaces root (CASHU_WORKSPACES_DIR, autouse in conftest),
HOME when the default location is checked, and a synthetic skills tree (the real repo skills are
used by one test only).
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
from rich.console import Console
from typer.testing import CliRunner

from cashu import cli as cli_mod
from cashu.core import cliutil, paths, runtime
from cashu.core.workspace import render, service, skills

SKILL_NAMES = (
    "budget-setup",
    "assets-setup",
    "loans-setup",
    "investments-setup",
    "import-builder",
    "extension-builder",
)


def _skill(root: Path, name: str, body: str = "") -> Path:
    folder = root / name
    (folder / "references").mkdir(parents=True)
    (folder / "SKILL.md").write_text(f"---\nname: {name}\ndescription: test\n---\n{body}\n")
    (folder / "references" / "notes.md").write_text(f"reference of {name}\n")
    return folder


@pytest.fixture
def skill_tree(tmp_path, monkeypatch) -> Path:
    root = tmp_path / "shipped-skills"
    for name in SKILL_NAMES:
        _skill(root, name)
    monkeypatch.setattr(skills, "source_dir", lambda: root)
    return root


@pytest.fixture
def client(api_empty, skill_tree):
    r = api_empty.post(
        "/api/profiles", json={"name": "Anna Test", "modules": ["budget", "investments"]}
    )
    assert r.status_code == 201, r.text
    r = api_empty.post("/api/profiles", json={"name": "Bolek Test", "modules": ["budget"]})
    assert r.status_code == 201, r.text
    return api_empty


def _ws(tmp_path: Path, slug: str) -> Path:
    return (tmp_path / "workspaces" / slug).resolve()


def _skills_in(ws: Path) -> set[str]:
    return {p.name for p in (ws / ".claude" / "skills").iterdir() if not p.name.startswith(".")}


def _json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


# --------------------------------------------------------------------------- #
# Location
# --------------------------------------------------------------------------- #


def test_default_location_is_documents_in_home(tmp_path, monkeypatch):
    monkeypatch.delenv(service.WORKSPACES_ENV)
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    assert (
        service.default_path("anna-test")
        == tmp_path / "home" / "Documents" / "cashU" / "anna-test"
    )


def test_status_before_creation(client, tmp_path):
    body = client.get("/api/p/anna-test/workspace").json()
    assert body["exists"] is False and body["configured"] is False and body["custom"] is False
    assert body["path"] == str(_ws(tmp_path, "anna-test"))
    assert body["outdated"] == [] and body["up_to_date"] is False
    assert body["claude_command"] == f"cd {_ws(tmp_path, 'anna-test')} && claude"
    assert not _ws(tmp_path, "anna-test").exists()  # GET never writes


def test_default_for_a_new_profile_name(client, tmp_path):
    body = client.get("/api/workspaces/default", params={"name": "Jan Łoś"}).json()
    assert body == {
        "root": str(tmp_path / "workspaces"),
        "slug": "jan-los",
        "path": str(tmp_path / "workspaces" / "jan-los"),
    }
    taken = client.get("/api/workspaces/default", params={"name": "Anna Test"}).json()
    assert taken["slug"] == "anna-test-2"
    assert client.get("/api/workspaces/default").json()["path"] is None


# --------------------------------------------------------------------------- #
# Create and update
# --------------------------------------------------------------------------- #


def test_create_writes_every_managed_part(client, tmp_path):
    r = client.post("/api/p/anna-test/workspace", json={})
    assert r.status_code == 200, r.text
    body = r.json()
    ws = _ws(tmp_path, "anna-test")
    assert body["exists"] and body["up_to_date"] and body["path"] == str(ws)
    assert body["managed_version"] == body["current_version"]
    assert {c["kind"] for c in body["changes"]} >= {
        "folder",
        "claude_md",
        "mcp",
        "settings",
        "skill",
    }

    for folder in ("notes", "research", "scripts", "connectors", "inbox"):
        assert (ws / folder).is_dir()
    assert "inbox/" in (ws / ".gitignore").read_text()

    text = (ws / "CLAUDE.md").read_text()
    for name in render.SECTIONS:
        assert f"<!-- cashu:begin {name} -->" in text and f"<!-- cashu:end {name} -->" in text
    assert "cashU profile `anna-test`" in text and "cashu-anna-test" in text
    assert "Anna" not in text  # the display name (a person's name) is never written
    assert (
        "**strict**" in text
        and "`portfolio_overview`" in text
        and "`set_merchant_category`" in text
    )
    assert "`loans_summary`" not in text  # loans module is off
    assert str(paths.data_dir().resolve()) in text
    assert "market research skill is not part of this cashU version" in text
    assert "\u2014" not in text

    mcp = _json(ws / ".mcp.json")
    assert list(mcp["mcpServers"]) == ["cashu-anna-test"]
    entry = mcp["mcpServers"]["cashu-anna-test"]
    assert entry["args"][-3:] == ["mcp", "--profile", "anna-test"]
    assert entry["command"] == service.cli_program()[0]

    settings = _json(ws / ".claude" / "settings.json")
    allow = settings["permissions"]["allow"]
    assert "mcp__cashu-anna-test__profile_overview" in allow
    assert "mcp__cashu-anna-test__positions" in allow
    assert not any("loans_summary" in rule for rule in allow)
    deny = settings["permissions"]["deny"]
    data = "/" + paths.data_dir().resolve().as_posix()
    assert f"Read({data}/**)" in deny and f"Edit({data}/**)" in deny
    # inbox/ is the user's drop folder: not denied (F10 11.3.1)
    assert not any("inbox" in rule for rule in deny), deny
    assert settings["enabledMcpjsonServers"] == ["cashu-anna-test"]

    assert _skills_in(ws) == {
        "budget-setup",
        "investments-setup",
        "import-builder",
        "extension-builder",
    }
    copied = ws / ".claude" / "skills" / "investments-setup" / "references" / "notes.md"
    assert copied.read_text() == "reference of investments-setup\n"
    manifest = _json(ws / service.MANIFEST_FILE)
    assert manifest["profile"] == "anna-test"
    assert set(manifest["skills"]) == _skills_in(ws)
    assert all(re.fullmatch(r"[0-9a-f]{12}", s["version"]) for s in manifest["skills"].values())

    assert _json(service.config_path("anna-test")) == {
        "path": str(ws),
        "routine_permissions": False,
    }
    assert body["routine_permissions"] is False
    assert not {"WebSearch", "WebFetch"} & set(allow)
    assert (service.config_path("anna-test").stat().st_mode & 0o777) == 0o600
    assert (ws.stat().st_mode & 0o777) == 0o700


def test_update_is_idempotent(client, tmp_path):
    client.post("/api/p/anna-test/workspace", json={})
    ws = _ws(tmp_path, "anna-test")
    before = {p: p.read_bytes() for p in ws.rglob("*") if p.is_file()}
    again = client.post("/api/p/anna-test/workspace", json={}).json()
    assert again["changes"] == [] and again["up_to_date"]
    assert {p: p.read_bytes() for p in ws.rglob("*") if p.is_file()} == before


def test_update_lifts_the_old_inbox_deny_rule_and_keeps_user_rules(client, tmp_path):
    """F10 11.3.1: a workspace written before (``Read/Edit(<ws>/inbox/**)`` denied) loses those two
    rules on update, also when its manifest does not list them; the user's own rules stay."""
    client.post("/api/p/anna-test/workspace", json={})
    ws = _ws(tmp_path, "anna-test")
    inbox = "/" + (ws / "inbox").as_posix()
    old = [f"Read({inbox}/**)", f"Edit({inbox}/**)"]
    settings = _json(ws / ".claude" / "settings.json")
    settings["permissions"]["deny"] += [*old, "Read(./secret/**)"]
    (ws / ".claude" / "settings.json").write_text(json.dumps(settings))
    manifest_path = ws / ".claude" / "cashu-workspace.json"
    manifest = _json(manifest_path)
    for key in ("deny", "deny_rules"):
        if isinstance(manifest.get(key), list):
            manifest[key] = [*manifest[key], *old]  # as an older version recorded them
    manifest_path.write_text(json.dumps(manifest))
    client.post("/api/p/anna-test/workspace", json={})
    deny = _json(ws / ".claude" / "settings.json")["permissions"]["deny"]
    assert not any(r in deny for r in old), deny
    assert "Read(./secret/**)" in deny
    data = "/" + paths.data_dir().resolve().as_posix()
    assert f"Read({data}/**)" in deny
    # the rendered boundaries name the inbox as the user's
    text = " ".join((ws / "CLAUDE.md").read_text().split())
    assert "Files in `inbox/` are the user's" in text and "You never open them" not in text
    assert "Files or rows the user hands you themselves are their choice" in text
    assert "Ustawienia > Konektory" in text and "connectors/<id>/" in text


def test_update_keeps_user_files(client, tmp_path):
    client.post("/api/p/anna-test/workspace", json={})
    ws = _ws(tmp_path, "anna-test")
    # the user's own things
    claude = ws / "CLAUDE.md"
    claude.write_text(claude.read_text() + "\nMoja notatka: pytaj zawsze o horyzont.\n")
    (ws / "notes" / "mine.md").write_text("notes of the user\n")
    _skill(ws / ".claude" / "skills", "my-own-skill", "mine")
    mcp = _json(ws / ".mcp.json")
    mcp["mcpServers"]["weather"] = {"command": "weather-mcp"}
    mcp["mcpServers"]["cashu-bolek-test"] = {"command": "cashu", "args": ["mcp"]}  # copied over
    (ws / ".mcp.json").write_text(json.dumps(mcp))
    settings = _json(ws / ".claude" / "settings.json")
    settings["permissions"]["allow"].append("WebSearch")
    settings["permissions"]["allow"].append("mcp__cashu-bolek-test__positions")
    settings["permissions"]["deny"].append("Read(./secret/**)")
    settings["model"] = "opus"
    (ws / ".claude" / "settings.json").write_text(json.dumps(settings))
    # a managed section edited by hand
    claude.write_text(claude.read_text().replace("Base currency: PLN", "Base currency: XXX"))

    status = client.get("/api/p/anna-test/workspace").json()
    reasons = {(i["kind"], i["name"], i["reason"]) for i in status["outdated"]}
    assert ("claude_md", "profile", "outdated") in reasons
    assert ("mcp", ".mcp.json", "outdated") in reasons
    assert ("settings", ".claude/settings.json", "outdated") in reasons
    assert not any(i["name"] == "my-own-skill" for i in status["outdated"])

    body = client.post("/api/p/anna-test/workspace", json={}).json()
    assert body["up_to_date"], body["outdated"]
    text = claude.read_text()
    assert "Moja notatka: pytaj zawsze o horyzont." in text and "Base currency: PLN" in text
    assert (ws / "notes" / "mine.md").read_text() == "notes of the user\n"
    assert (ws / ".claude" / "skills" / "my-own-skill" / "SKILL.md").read_text().endswith("mine\n")
    servers = _json(ws / ".mcp.json")["mcpServers"]
    assert set(servers) == {"cashu-anna-test", "weather"}  # the other profile's server is gone
    settings = _json(ws / ".claude" / "settings.json")
    assert "WebSearch" in settings["permissions"]["allow"]
    assert "mcp__cashu-bolek-test__positions" not in settings["permissions"]["allow"]
    assert "Read(./secret/**)" in settings["permissions"]["deny"]
    assert settings["model"] == "opus"


def test_missing_sections_and_files_come_back(client, tmp_path):
    client.post("/api/p/anna-test/workspace", json={})
    ws = _ws(tmp_path, "anna-test")
    text = (ws / "CLAUDE.md").read_text()
    start = text.index("<!-- cashu:begin tools -->")
    end = text.index("<!-- cashu:end tools -->") + len("<!-- cashu:end tools -->")
    (ws / "CLAUDE.md").write_text(text[:start] + text[end:])
    (ws / ".mcp.json").unlink()
    (ws / "research").rmdir()
    status = client.get("/api/p/anna-test/workspace").json()
    reasons = {(i["kind"], i["name"], i["reason"]) for i in status["outdated"]}
    assert reasons == {
        ("claude_md", "tools", "missing"),
        ("mcp", ".mcp.json", "missing"),
        ("folder", "research", "missing"),
    }
    body = client.post("/api/p/anna-test/workspace", json={}).json()
    assert body["up_to_date"]
    fixed = (ws / "CLAUDE.md").read_text()
    order = [fixed.index(f"<!-- cashu:begin {n} -->") for n in render.SECTIONS]
    assert order == sorted(order)


def test_unreadable_json_is_backed_up_and_rewritten(client, tmp_path):
    client.post("/api/p/anna-test/workspace", json={})
    ws = _ws(tmp_path, "anna-test")
    (ws / ".mcp.json").write_text("{not json")
    assert {"kind": "mcp", "name": ".mcp.json", "reason": "invalid"} in client.get(
        "/api/p/anna-test/workspace"
    ).json()["outdated"]
    body = client.post("/api/p/anna-test/workspace", json={}).json()
    assert {"kind": "mcp", "name": ".mcp.json", "action": "backed_up"} in body["changes"]
    assert list(_json(ws / ".mcp.json")["mcpServers"]) == ["cashu-anna-test"]
    backups = list((ws / service.BACKUP_DIR).rglob(".mcp.json"))
    assert len(backups) == 1 and backups[0].read_text() == "{not json"


def test_existing_claude_md_without_markers_keeps_the_user_text(client, tmp_path):
    ws = tmp_path / "custom-ws"
    ws.mkdir()
    (ws / "CLAUDE.md").write_text("# Moje\n\nTekst użytkownika.\n")
    body = client.post("/api/p/anna-test/workspace", json={"path": str(ws)}).json()
    assert body["exists"] and body["custom"] and body["path"] == str(ws.resolve())
    text = (ws / "CLAUDE.md").read_text()
    assert text.startswith("# Moje\n\n<!-- cashu:begin profile -->")
    assert text.rstrip().endswith("Tekst użytkownika.")


# --------------------------------------------------------------------------- #
# Skills
# --------------------------------------------------------------------------- #


def test_module_changes_update_the_skill_set(client, tmp_path):
    client.post("/api/p/anna-test/workspace", json={})
    ws = _ws(tmp_path, "anna-test")
    r = client.put("/api/profiles/anna-test/modules", json={"modules": ["budget", "loans"]})
    assert r.status_code == 200
    assert _skills_in(ws) == {"budget-setup", "import-builder", "loans-setup"}  # F10: budget too
    text = (ws / "CLAUDE.md").read_text()
    assert "`loans_summary`" in text and "`portfolio_overview`" not in text
    assert "investments module is off" in text
    allow = _json(ws / ".claude" / "settings.json")["permissions"]["allow"]
    assert "mcp__cashu-anna-test__loans_summary" in allow
    assert not any("portfolio_overview" in rule for rule in allow)
    assert client.get("/api/p/anna-test/workspace").json()["up_to_date"]
    # the other profile (no workspace) is untouched
    assert not _ws(tmp_path, "bolek-test").exists()


def test_privacy_change_updates_claude_md(client, tmp_path):
    client.post("/api/p/anna-test/workspace", json={})
    ws = _ws(tmp_path, "anna-test")
    assert (
        client.patch("/api/profiles/anna-test", json={"mcp_privacy": "amounts"}).status_code == 200
    )
    assert "**amounts** (Z kwotami)" in (ws / "CLAUDE.md").read_text()


def test_profile_without_workspace_changes_modules_without_writing(client, tmp_path):
    r = client.put("/api/profiles/bolek-test/modules", json={"modules": ["budget", "assets"]})
    assert r.status_code == 200
    assert not (tmp_path / "workspaces").exists()


def test_edited_managed_skill_is_kept_until_forced(client, tmp_path):
    client.post("/api/p/anna-test/workspace", json={})
    ws = _ws(tmp_path, "anna-test")
    edited = ws / ".claude" / "skills" / "investments-setup" / "SKILL.md"
    edited.write_text(edited.read_text() + "my change\n")
    (skills.source_dir() / "investments-setup" / "SKILL.md").write_text("new shipped version\n")

    status = client.get("/api/p/anna-test/workspace").json()
    assert {"kind": "skill", "name": "investments-setup", "reason": "modified"} in status[
        "outdated"
    ]
    body = client.post("/api/p/anna-test/workspace", json={}).json()
    assert {"kind": "skill", "name": "investments-setup", "action": "kept"} in body["changes"]
    assert edited.read_text().endswith("my change\n")
    assert not body["up_to_date"]

    forced = client.post("/api/p/anna-test/workspace", json={"force": True}).json()
    assert {"kind": "skill", "name": "investments-setup", "action": "replaced"} in forced["changes"]
    assert edited.read_text() == "new shipped version\n" and forced["up_to_date"]
    backup = list((ws / service.BACKUP_DIR).rglob("investments-setup/SKILL.md"))
    assert len(backup) == 1 and backup[0].read_text().endswith("my change\n")


def test_shipped_skill_update_replaces_an_unedited_copy(client, tmp_path):
    client.post("/api/p/anna-test/workspace", json={})
    ws = _ws(tmp_path, "anna-test")
    (skills.source_dir() / "import-builder" / "references" / "new.md").write_text("added\n")
    status = client.get("/api/p/anna-test/workspace").json()
    assert status["outdated"] == [{"kind": "skill", "name": "import-builder", "reason": "outdated"}]
    body = client.post("/api/p/anna-test/workspace", json={}).json()
    assert {"kind": "skill", "name": "import-builder", "action": "updated"} in body["changes"]
    assert (ws / ".claude" / "skills" / "import-builder" / "references" / "new.md").is_file()


def test_user_folder_with_a_skill_name_is_a_conflict(client, tmp_path):
    ws = tmp_path / "ws-conflict"
    _skill(ws / ".claude" / "skills", "budget-setup", "the user's own budget skill")
    # an identical copy (e.g. from `cashu skills install --dest`) is adopted silently
    shutil.copytree(
        skills.source_dir() / "import-builder", ws / ".claude" / "skills" / "import-builder"
    )
    body = client.post("/api/p/anna-test/workspace", json={"path": str(ws)}).json()
    assert {"kind": "skill", "name": "budget-setup", "reason": "conflict"} in body["outdated"]
    assert not any(i["name"] == "import-builder" for i in body["outdated"])
    own = ws / ".claude" / "skills" / "budget-setup" / "SKILL.md"
    assert own.read_text().endswith("the user's own budget skill\n")
    assert "budget-setup" not in _json(ws / service.MANIFEST_FILE)["skills"]


def test_edited_skill_of_a_disabled_module_stays_as_the_users(client, tmp_path):
    client.post("/api/p/anna-test/workspace", json={})
    ws = _ws(tmp_path, "anna-test")
    edited = ws / ".claude" / "skills" / "extension-builder" / "SKILL.md"
    edited.write_text("mine now\n")
    client.put("/api/profiles/anna-test/modules", json={"modules": ["budget"]})
    assert _skills_in(ws) == {"budget-setup", "import-builder", "extension-builder"}
    assert edited.read_text() == "mine now\n"
    assert "extension-builder" not in _json(ws / service.MANIFEST_FILE)["skills"]
    assert client.get("/api/p/anna-test/workspace").json()["up_to_date"]


def test_market_research_skill_when_shipped(client, tmp_path):
    _skill(skills.source_dir(), "market-research")
    body = client.post("/api/p/anna-test/workspace", json={}).json()
    ws = _ws(tmp_path, "anna-test")
    assert "market-research" in _skills_in(ws)
    text = (ws / "CLAUDE.md").read_text()
    assert "Run `/market-research` on Saturday" in text
    # a LOCAL routine (cloud routines cannot reach the local MCP server), set up only with a yes
    assert (
        "Code > Routines >\n  New routine > Local" in text and "`/market-research rutyna`" in text
    )
    assert f"`cd {ws} && claude -p '/market-research rutyna'`" in text
    assert "only after the user approves the schedule" in text
    assert "Unattended permissions (opt-in, Ustawienia > Agent AI): **off**." in text
    assert body["up_to_date"]
    assert body["routine_command"] == f"cd {ws} && claude -p '/market-research rutyna'"


def test_routine_permissions_are_opt_in(client, tmp_path):
    _skill(skills.source_dir(), "market-research")
    client.post("/api/p/anna-test/workspace", json={})
    ws = _ws(tmp_path, "anna-test")
    settings_file = ws / ".claude" / "settings.json"
    # the user allowed WebSearch by hand: cashU never removes it
    settings = _json(settings_file)
    settings["permissions"]["allow"].append("WebSearch")
    settings_file.write_text(json.dumps(settings))
    routine = [
        "WebFetch",
        f"Edit(/{(ws / 'research').as_posix()}/**)",
        f"Edit(/{(ws / 'notes').as_posix()}/**)",
    ]
    deny = _json(settings_file)["permissions"]["deny"]

    on = client.post("/api/p/anna-test/workspace", json={"routine_permissions": True}).json()
    assert on["routine_permissions"] is True and on["up_to_date"]
    allow = _json(settings_file)["permissions"]["allow"]
    assert set(routine) | {"WebSearch"} <= set(allow) and allow.count("WebSearch") == 1
    assert not any(r.startswith("Edit(") and "inbox" in r for r in allow)
    assert _json(settings_file)["permissions"]["deny"] == deny  # deny rules in both states
    assert (
        "Unattended permissions (opt-in, Ustawienia > Agent AI): **on**."
        in (ws / "CLAUDE.md").read_text()
    )
    assert _json(service.config_path("anna-test"))["routine_permissions"] is True
    # without the investments module (no routine) the rules go; the choice is kept for later
    client.put("/api/profiles/anna-test/modules", json={"modules": ["budget"]})
    assert not set(routine) & set(_json(settings_file)["permissions"]["allow"])
    assert "WebSearch" in _json(settings_file)["permissions"]["allow"]  # the user's own
    client.put("/api/profiles/anna-test/modules", json={"modules": ["budget", "investments"]})
    client.post("/api/p/anna-test/workspace", json={})
    assert set(routine) <= set(_json(settings_file)["permissions"]["allow"])
    assert client.get("/api/p/anna-test/workspace").json()["routine_permissions"] is True

    off = client.post("/api/p/anna-test/workspace", json={"routine_permissions": False}).json()
    assert off["routine_permissions"] is False and off["up_to_date"]
    allow = _json(settings_file)["permissions"]["allow"]
    assert not set(routine) & set(allow)
    assert "WebSearch" in allow  # the user's own rule from before stays
    assert _json(settings_file)["permissions"]["deny"] == deny


def test_routine_off_keeps_a_users_own_web_rules(client, tmp_path):
    client.post("/api/p/anna-test/workspace", json={})
    ws = _ws(tmp_path, "anna-test")
    settings_file = ws / ".claude" / "settings.json"
    settings = _json(settings_file)
    settings["permissions"]["allow"] += ["WebSearch", "WebFetch"]
    settings_file.write_text(json.dumps(settings))
    body = client.post("/api/p/anna-test/workspace", json={"routine_permissions": False}).json()
    assert body["up_to_date"]
    assert {"WebSearch", "WebFetch"} <= set(_json(settings_file)["permissions"]["allow"])


def test_with_the_real_repo_skills(api_empty, tmp_path):
    api_empty.post("/api/profiles", json={"name": "Real Test", "modules": ["investments"]})
    body = api_empty.post("/api/p/real-test/workspace", json={}).json()
    ws = _ws(tmp_path, "real-test")
    assert {"investments-setup", "import-builder", "extension-builder"} <= _skills_in(ws)
    refs = ws / ".claude" / "skills" / "investments-setup" / "references"
    assert (refs / "strategy-schema.md").is_file() and (refs / "expressions.md").is_file()
    assert body["up_to_date"]


# --------------------------------------------------------------------------- #
# Path checks and profile isolation
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "where, message, code",
    [
        ("relative/path", "absolute", "path_relative"),
        ("{data}/ws", "outside the cashU data dir", "path_data_dir"),
        ("{tmp}/.hidden/ws", "hidden folder", "path_hidden"),
        ("{home}", "home folder", "path_home"),
        ("{file}", "is a file", "path_is_file"),
        ("{checkout}/ws", "source checkout", "path_checkout"),
    ],
)
def test_bad_paths_are_refused(client, tmp_path, monkeypatch, where, message, code):
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    (tmp_path / "home").mkdir()
    (tmp_path / "a-file").write_text("x")
    raw = where.format(
        data=paths.data_dir(),
        tmp=tmp_path,
        home=tmp_path / "home",
        file=tmp_path / "a-file",
        checkout=paths.PROJECT_ROOT,
    )
    r = client.post("/api/p/anna-test/workspace", json={"path": raw})
    assert r.status_code == 422, r.text
    assert message in r.json()["detail"]
    assert r.headers["X-Cashu-Error-Code"] == code


def test_folder_containing_the_data_dir_is_refused(client, tmp_path):
    r = client.post("/api/p/anna-test/workspace", json={"path": str(tmp_path)})
    assert r.status_code == 422 and "must not contain it" in r.json()["detail"]


def test_profiles_cannot_share_a_workspace(client, tmp_path):
    shared = tmp_path / "shared"
    assert client.post("/api/p/anna-test/workspace", json={"path": str(shared)}).status_code == 200
    for target in (shared, shared / "inner"):
        r = client.post("/api/p/bolek-test/workspace", json={"path": str(target)})
        assert r.status_code == 409, r.text
        assert r.headers["X-Cashu-Error-Code"] == "workspace_taken"
    # Bolek's status shows his own (default) workspace, never Anna's folder
    status = client.get("/api/p/bolek-test/workspace").json()
    assert status["path"] == str(_ws(tmp_path, "bolek-test")) and status["exists"] is False
    # a folder whose manifest names another profile is refused too (copied workspace)
    copy = tmp_path / "copied"
    (copy / ".claude").mkdir(parents=True)
    (copy / service.MANIFEST_FILE).write_text(json.dumps({"profile": "anna-test"}))
    r = client.post("/api/p/bolek-test/workspace", json={"path": str(copy)})
    assert r.status_code == 409


def test_moving_the_workspace_leaves_the_old_one(client, tmp_path):
    client.post("/api/p/anna-test/workspace", json={})
    old = _ws(tmp_path, "anna-test")
    new = tmp_path / "elsewhere" / "anna"
    body = client.post("/api/p/anna-test/workspace", json={"path": str(new)}).json()
    assert body["path"] == str(new.resolve()) and body["moved_from"] == str(old)
    assert (old / "CLAUDE.md").is_file() and (new / "CLAUDE.md").is_file()
    assert client.get("/api/p/anna-test/workspace").json()["path"] == str(new.resolve())


def test_unknown_profile_is_404(client):
    assert client.get("/api/p/nobody/workspace").status_code == 404
    assert client.post("/api/p/nobody/workspace", json={}).status_code == 404


def test_translocated_app_is_refused(client, monkeypatch):
    monkeypatch.setattr(runtime, "translocated", lambda: True)
    r = client.post("/api/p/anna-test/workspace", json={})
    assert r.status_code == 422 and r.headers["X-Cashu-Error-Code"] == "translocated"


def test_packaged_app_points_mcp_at_the_bundled_binary(client, tmp_path, monkeypatch):
    exe = tmp_path / "cashU.app" / "Contents" / "MacOS" / "cashu"
    monkeypatch.setattr(runtime, "frozen", lambda: True)
    monkeypatch.setattr(runtime, "executable", lambda: exe)
    client.post("/api/p/anna-test/workspace", json={})
    ws = _ws(tmp_path, "anna-test")
    assert _json(ws / ".mcp.json")["mcpServers"]["cashu-anna-test"]["command"] == str(exe)
    assert f"`{exe} --profile anna-test ...`" in (ws / "CLAUDE.md").read_text()


def test_source_install_points_mcp_at_the_venv_script(monkeypatch):
    script = Path(sys.executable).parent / "cashu"
    if script.is_file():
        assert service.cli_program() == [str(script)]
    monkeypatch.setattr(sys, "executable", "/nonexistent/bin/python")
    monkeypatch.setattr(service.shutil, "which", lambda _name: None)
    assert service.cli_program() == ["cashu"]


def test_rule_paths():
    assert render.rule_path(Path("/Users/x/Library/Application Support/cashU")) == (
        "//Users/x/Library/Application Support/cashU"
    )
    assert render.rule_path(Path("C:\\Users\\x\\AppData\\cashu")) == "//c/Users/x/AppData/cashu"


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #


@pytest.fixture
def run(monkeypatch, db_engine, skill_tree):
    monkeypatch.setattr(cliutil, "console", Console(width=200, color_system=None))
    monkeypatch.setattr(cliutil, "err_console", Console(width=200, color_system=None, stderr=True))
    monkeypatch.setattr(cliutil, "_profile_slug", None)
    runner = CliRunner()

    def _run(*args, code=0):
        res = runner.invoke(cli_mod.app, [str(a) for a in args])
        assert res.exit_code == code, res.output + repr(res.exception)
        return res

    return _run


def test_cli_init_update_path(run, tmp_path):
    run("profiles", "add", "Cli Test", "--modules", "budget,investments")
    ws = _ws(tmp_path, "cli-test")
    assert run("workspace", "path", "-p", "cli-test").output.strip() == str(ws)
    out = run("workspace", "init", "-p", "cli-test").output
    assert "created  skill budget-setup" in out and f"cd {ws} && claude" in out
    assert "Workspace is up to date." in run("--profile", "cli-test", "workspace", "update").output
    run("workspace", "update", "-p", "cli-test", "--routine-permissions")
    allow = _json(ws / ".claude" / "settings.json")["permissions"]["allow"]
    assert "WebFetch" in allow
    run("workspace", "update", "-p", "cli-test", "--no-routine-permissions")
    assert "WebFetch" not in _json(ws / ".claude" / "settings.json")["permissions"]["allow"]
    custom = tmp_path / "cli-custom"
    run("workspace", "init", "-p", "cli-test", "--path", str(custom))
    assert run("workspace", "path", "-p", "cli-test").output.strip() == str(custom.resolve())
    bad = run("workspace", "init", "-p", "cli-test", "--path", "relative", code=1)
    assert "absolute" in bad.output
    assert run("workspace", "update", "-p", "nobody", code=1)


def test_cli_without_profiles(run):
    assert "No profile yet" in run("workspace", "init", code=1).output


# --------------------------------------------------------------------------- #
# Shipped skills: mapping and self-contained references
# --------------------------------------------------------------------------- #

REPO_SKILLS = paths.PROJECT_ROOT / ".claude" / "skills"
# File references that exist only in a source checkout.
REPO_ONLY = re.compile(
    r"src/cashu/|docs/import-format|tests/[a-z_/]+\.py|AGENTS\.md|ONBOARDING\.md"
    r"|from cashu\.core import paths"
)


def test_every_shipped_skill_belongs_to_a_module():
    shipped = sorted(p.name for p in REPO_SKILLS.iterdir() if (p / "SKILL.md").is_file())
    assert shipped and all(skills.module_of(name) for name in shipped), shipped


def test_skills_do_not_reference_repository_files():
    offending = []
    for file in REPO_SKILLS.rglob("*"):
        if file.is_file() and file.suffix in (".md", ".py", ".yaml"):
            for n, line in enumerate(file.read_text(encoding="utf-8").splitlines(), 1):
                if REPO_ONLY.search(line):
                    offending.append(f"{file.relative_to(REPO_SKILLS)}:{n}: {line.strip()}")
    assert not offending, "\n".join(offending)


def test_skill_reference_copies_are_current():
    script = paths.PROJECT_ROOT / "scripts" / "sync_skill_references.py"
    res = subprocess.run(
        [sys.executable, str(script), "--check"], capture_output=True, text=True, check=False
    )
    assert res.returncode == 0, res.stderr


def test_skill_references_resolve_inside_the_skill():
    """Every `references/...` a skill names exists in that skill's folder."""
    missing = []
    for skill_md in REPO_SKILLS.glob("*/SKILL.md"):
        folder = skill_md.parent
        for file in [skill_md, *folder.glob("references/*.md")]:
            text = file.read_text(encoding="utf-8")
            for ref in re.findall(r"`(references/[A-Za-z0-9_./*-]+)`", text):
                if "*" in ref or "<" in ref:
                    continue
                if not (folder / ref).exists():
                    missing.append(f"{folder.name}: {ref}")
    assert not missing, missing


# --------------------------------------------------------------------------- #
# F7 OB6 / OB7
# --------------------------------------------------------------------------- #


def test_protected_places_have_a_stable_order(tmp_path, monkeypatch):
    """OB6: equally deep places come out sorted by path, not in set order (CLAUDE.md boundaries and
    settings.json flapped between "outdated" and "up to date" across processes)."""
    names = ["zeta", "alpha", "mid", "beta"]
    for n in names:
        (tmp_path / n).mkdir()
    monkeypatch.setattr(paths, "data_dir", lambda: tmp_path / "zeta")
    monkeypatch.setattr(paths, "storage_dir", lambda: tmp_path / "mid")
    monkeypatch.setattr(paths, "LEGACY_DIR", tmp_path / "beta")
    monkeypatch.setattr(paths, "PROJECT_ROOT", tmp_path / "alpha" / "..")
    (tmp_path / "statements").mkdir()
    places = service.protected_places()
    assert list(places) == sorted(places, key=lambda p: (len(p.parts), str(p)))
    assert [p.name for p in places] == ["beta", "mid", "statements", "zeta"]


def test_status_flags_an_mcp_command_of_another_install(client, tmp_path):
    """OB7: a workspace written by another process (a dev venv, the app at its old path) keeps that
    CLI in .mcp.json; status says so and "Aktualizuj workspace" rewrites it."""
    assert client.post("/api/p/anna-test/workspace", json={}).status_code == 200
    ws = _ws(tmp_path, "anna-test")
    fresh = client.get("/api/p/anna-test/workspace").json()
    assert fresh["mcp_command_stale"] is False and fresh["up_to_date"]
    data = _json(ws / ".mcp.json")
    data["mcpServers"]["cashu-anna-test"]["command"] = "/old/venv/bin/cashu"
    (ws / ".mcp.json").write_text(json.dumps(data), encoding="utf-8")
    stale = client.get("/api/p/anna-test/workspace").json()
    assert stale["mcp_command_stale"] is True and stale["up_to_date"] is False
    updated = client.post("/api/p/anna-test/workspace", json={}).json()
    assert updated["mcp_command_stale"] is False and updated["up_to_date"]
    entry = _json(ws / ".mcp.json")["mcpServers"]["cashu-anna-test"]
    assert entry["command"] == service.cli_program()[0]
    # no workspace yet: never stale
    assert client.get("/api/p/bolek-test/workspace").json()["mcp_command_stale"] is False


# --------------------------------------------------------------------------- #
# F11: a workspace written before the rename (legacy name: finanse markers, manifest, server)
# --------------------------------------------------------------------------- #


def test_update_rewrites_a_workspace_from_before_the_rename(client, tmp_path):
    client.post("/api/p/anna-test/workspace", json={})
    ws = _ws(tmp_path, "anna-test")
    # turn it into what the old version wrote (legacy name everywhere)
    text = (ws / "CLAUDE.md").read_text()
    text = text.replace("<!-- cashu:", "<!-- finanse:").replace("# cashU agent workspace", "# finanse agent workspace")  # legacy name
    (ws / "CLAUDE.md").write_text(text + "\nMy own note stays.\n")
    manifest = _json(ws / service.MANIFEST_FILE)
    manifest["finanse_version"] = manifest.pop("cashu_version")  # legacy name
    (ws / service.LEGACY_MANIFEST_FILE).write_text(json.dumps(manifest))
    (ws / service.MANIFEST_FILE).unlink()
    mcp = _json(ws / ".mcp.json")
    mcp["mcpServers"] = {"finanse-anna-test": {"command": "/old/venv/bin/finanse", "args": ["mcp", "--profile", "anna-test"]}, "mine": {"command": "x"}}  # legacy name
    (ws / ".mcp.json").write_text(json.dumps(mcp))
    settings = _json(ws / ".claude" / "settings.json")
    settings["permissions"]["allow"] = ["mcp__finanse-anna-test__positions", "Bash(ls)"]  # legacy name
    settings["enabledMcpjsonServers"] = ["finanse-anna-test", "mine"]  # legacy name
    (ws / ".claude" / "settings.json").write_text(json.dumps(settings))

    status = client.get("/api/p/anna-test/workspace").json()
    assert status["exists"] and not status["up_to_date"]
    assert {"kind": "manifest", "name": str(service.LEGACY_MANIFEST_FILE), "reason": "outdated"} in status["outdated"]
    assert status["managed_version"]  # read from the legacy manifest key

    body = client.post("/api/p/anna-test/workspace", json={}).json()
    assert body["up_to_date"], body["outdated"]
    text = (ws / "CLAUDE.md").read_text()
    assert "<!-- finanse:" not in text and text.startswith("# cashU agent workspace")  # legacy name
    assert text.count("<!-- cashu:begin profile -->") == 1 and "My own note stays." in text
    assert not (ws / service.LEGACY_MANIFEST_FILE).exists() and (ws / service.MANIFEST_FILE).is_file()
    servers = _json(ws / ".mcp.json")["mcpServers"]
    assert set(servers) == {"cashu-anna-test", "mine"}
    # the app runs on an explicit data dir in tests: the server keeps it (the old update dropped it)
    assert servers["cashu-anna-test"]["env"] == {"CASHU_DATA_DIR": str(paths.data_dir_override())}
    settings = _json(ws / ".claude" / "settings.json")
    assert not any("finanse" in r for r in settings["permissions"]["allow"])  # legacy name
    assert "Bash(ls)" in settings["permissions"]["allow"]
    assert settings["enabledMcpjsonServers"] == ["cashu-anna-test", "mine"]
