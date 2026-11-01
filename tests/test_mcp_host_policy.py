"""Restrictive native-only guard sources on the local Python bridge; synthetic profiles only."""

import json
import re

import anyio
import pytest
from mcp_support import TODAY, seed_profile
from sqlmodel import select

from cashu.core.agent_models import McpCall, Review
from cashu.core.db import get_session
from cashu.core.mcp import labels as L
from cashu.core.mcp.names import NameGuard
from cashu.core.mcp.registry import ToolError, ToolSpec
from cashu.core.mcp.server import CashuMcp, build_server
from cashu.core.models import Profile

NATIVE_NAME = "Dorota Zawadzka"
PYTHON_NAME = "Marta Testowa"


def restriction(**fields):
    return {"persons": [], "strongNames": [], "privatePayees": [], "strictNames": [], **fields}


@pytest.fixture
def host(db_engine):
    pid, _slug = seed_profile(PYTHON_NAME, run_daily=False)
    return pid, CashuMcp(pid, today=TODAY)


def privacy(pid, value):
    with get_session() as s:
        row = s.get(Profile, pid)
        row.mcp_privacy = value
        s.add(row)


def set_tool(mcp, handler):
    mcp._tools["mark_review_done"] = ToolSpec(
        "mark_review_done", "core", "synthetic guard bridge", handler, write=True
    )


@pytest.mark.parametrize("mode", ["strict", "amounts"])
@pytest.mark.parametrize("field", ["persons", "strongNames", "privatePayees"])
def test_native_only_name_masks_handler_output_before_successful_commit(host, mode, field):
    pid, mcp = host
    privacy(pid, mode)

    def handler(ctx):
        ctx.session.add(Review(profile_id=pid, module="budget", notes=NATIVE_NAME))
        ctx.session.flush()
        return {
            "text": L.text(f"{NATIVE_NAME} and {PYTHON_NAME}"),
            "merchant": L.merchant(NATIVE_NAME),
        }

    set_tool(mcp, handler)
    result = mcp.call("mark_review_done", {}, name_guard=restriction(**{field: [NATIVE_NAME]}))
    assert result.ok, result.error
    assert result.name_guard_applied
    assert "Dorota" not in json.dumps(result.data) and "Marta" not in json.dumps(result.data)
    assert result.data["merchant"].startswith("payee:")
    with get_session() as s:
        assert s.exec(select(Review).where(Review.profile_id == pid)).one().notes == NATIVE_NAME
        assert s.exec(select(McpCall).where(McpCall.profile_id == pid)).one().args == {}
    # Restrictions are per-call, not retained in this server or persisted into profile settings.
    direct = mcp.call("mark_review_done", {})
    assert direct.ok and NATIVE_NAME in direct.data["text"]
    assert not direct.name_guard_applied


@pytest.mark.parametrize("mode", ["strict", "amounts"])
def test_native_numeric_private_symbol_overrides_python_public_symbol_exemption(
    host, monkeypatch, mode
):
    pid, mcp = host
    privacy(pid, mode)
    monkeypatch.setattr(
        "cashu.core.mcp.names.collect", lambda *_: NameGuard(pid, symbols=frozenset({"0700"}))
    )
    set_tool(mcp, lambda _ctx: {"symbol": L.symbol("0700")})
    assert mcp.call("mark_review_done", {}).data["symbol"] == "0700"
    result = mcp.call("mark_review_done", {}, name_guard=restriction(strongNames=["0700"]))
    assert result.ok and "0700" not in json.dumps(result.data)


def test_native_private_alias_cannot_escape_through_python_public_replacement(host, monkeypatch):
    pid, mcp = host
    monkeypatch.setattr(
        "cashu.core.mcp.names.collect",
        lambda *_: NameGuard(pid, strict_aliases=((NATIVE_NAME, "Public Fund"),)),
    )
    set_tool(mcp, lambda ctx: {"name": L.text(ctx.guard.public_name(NATIVE_NAME))})
    assert mcp.call("mark_review_done", {}).data["name"] == "Public Fund"
    result = mcp.call("mark_review_done", {}, name_guard=restriction(strongNames=[NATIVE_NAME]))
    assert result.ok and result.data["name"] == "[name]"


def test_partial_alias_conflict_does_not_reveal_the_previously_hidden_suffix(host, monkeypatch):
    pid, mcp = host
    alias = "ACME Private Goal"
    monkeypatch.setattr(
        "cashu.core.mcp.names.collect",
        lambda *_: NameGuard(pid, strict_aliases=((alias, "Public ETF"),)),
    )
    set_tool(mcp, lambda ctx: {"name": L.text(ctx.guard.public_name(alias)), "echo": L.text(alias)})
    result = mcp.call("mark_review_done", {}, name_guard=restriction(persons=["ACME"]))
    assert result.ok and result.data == {"name": "[name]", "echo": "[name]"}


@pytest.mark.parametrize("label", [L.text, L.fixed_text], ids=["text", "authored"])
def test_baseline_alias_cannot_split_native_name_before_masking(host, monkeypatch, label):
    pid, mcp = host
    monkeypatch.setattr(
        "cashu.core.mcp.names.collect",
        lambda *_: NameGuard(pid, strict_aliases=(("Anna", "Public Fund"),)),
    )
    set_tool(
        mcp,
        lambda _ctx: {
            "private": label("Anna-Li"),
            "baseline": label("Invest in Anna"),
            "ordinary": label("Public commentary"),
        },
    )
    result = mcp.call("mark_review_done", {}, name_guard=restriction(persons=["Anna-Li"]))
    assert result.ok and result.data == {
        "private": "[name]",
        "baseline": "Invest in Public Fund",
        "ordinary": "Public commentary",
    }


def test_error_alias_substitution_cannot_split_native_name_before_masking(host, monkeypatch):
    pid, mcp = host
    monkeypatch.setattr(
        "cashu.core.mcp.names.collect",
        lambda *_: NameGuard(pid, strict_aliases=(("Anna", "Public Fund"),)),
    )

    def handler(_ctx):
        raise ToolError("Cannot save Anna-Li")

    set_tool(mcp, handler)
    result = mcp.call("mark_review_done", {}, name_guard=restriction(persons=["Anna-Li"]))
    assert not result.ok and result.name_guard_applied and result.error == "[name]"


@pytest.mark.parametrize("mode", ["strict", "amounts"])
def test_alias_origins_are_masked_only_under_effective_strict_policy(host, mode):
    pid, mcp = host
    privacy(pid, mode)
    set_tool(mcp, lambda _ctx: {"name": L.text("Native goal 2030")})
    result = mcp.call(
        "mark_review_done", {}, name_guard=restriction(strictNames=["Native goal 2030"])
    )
    assert result.ok
    assert ("Native" in result.data["name"]) == (mode == "amounts")


def test_longer_native_overlap_cannot_expose_a_name_python_already_masked(host, monkeypatch):
    pid, mcp = host
    monkeypatch.setattr(
        "cashu.core.mcp.names.collect", lambda *_: NameGuard(pid, names=frozenset({"ANNA NOWAK"}))
    )
    set_tool(mcp, lambda _ctx: {"text": L.text("Anna Nowak Kowalski")})
    result = mcp.call("mark_review_done", {}, name_guard=restriction(persons=["Nowak Kowalski"]))
    assert result.ok and "Anna" not in result.data["text"]


@pytest.mark.parametrize("mode", ["strict", "amounts"])
@pytest.mark.parametrize("native_name", ["Al Li", "AnnaLi", "Anna 2030"])
def test_python_mask_does_not_expose_residual_native_name_fragments(
    host, monkeypatch, native_name, mode
):
    pid, mcp = host
    privacy(pid, mode)
    monkeypatch.setattr(
        "cashu.core.mcp.names.collect", lambda *_: NameGuard(pid, names=frozenset({"AL", "ANNA"}))
    )
    set_tool(mcp, lambda _ctx: {"text": L.text(native_name)})
    result = mcp.call("mark_review_done", {}, name_guard=restriction(persons=[native_name]))
    assert result.ok and re.fullmatch(r"(?:\[(?:name|amount)\]\s*)+", result.data["text"])


def test_guard_collection_failure_never_sends_unaugmented_error_text(host, monkeypatch):
    def broken_guard(*_args):
        raise ToolError(NATIVE_NAME)

    monkeypatch.setattr("cashu.core.mcp.names.collect", broken_guard)
    _pid, mcp = host
    set_tool(mcp, lambda _ctx: pytest.fail("unavailable guard reached handler"))
    result = mcp.call("mark_review_done", {}, name_guard=restriction(persons=[NATIVE_NAME]))
    assert not result.ok and not result.name_guard_applied
    assert "Dorota" not in result.error


@pytest.mark.parametrize("failure", ["tool", "privacy"])
def test_failed_write_rolls_back_and_error_uses_the_same_augmented_guard(host, failure):
    pid, mcp = host

    def handler(ctx):
        ctx.session.add(Review(profile_id=pid, module="budget", notes="synthetic"))
        ctx.session.flush()
        if failure == "tool":
            raise ToolError(f"Cannot save {NATIVE_NAME}")
        return {"unsafe": L.pct(12345678901)}

    set_tool(mcp, handler)
    result = mcp.call("mark_review_done", {}, name_guard=restriction(strongNames=[NATIVE_NAME]))
    assert not result.ok and result.name_guard_applied
    assert "Dorota" not in result.error and "Zawadzka" not in result.error
    with get_session() as s:
        assert s.exec(select(Review).where(Review.profile_id == pid)).all() == []


@pytest.mark.parametrize(
    "payload",
    [
        None,
        [],
        {},
        restriction(persons="not an array"),
        restriction(strongNames=[1]),
        restriction(symbols=["0700"]),
        restriction(strictAliases=[[NATIVE_NAME, "Public Fund"]]),
        restriction(persons=["x"] * 4097),
        restriction(persons=["x" * 2049]),
        restriction(persons=["a" * 2048] * 513),
        restriction(persons=["😀" * 1024] * 257),
        restriction(persons=["\ud800"]),
    ],
)
def test_malformed_or_oversized_guard_refuses_before_handler(host, payload):
    pid, mcp = host

    def handler(_ctx):
        pytest.fail("invalid guard metadata reached a write handler")

    set_tool(mcp, handler)
    result = mcp.call("mark_review_done", {}, name_guard=payload)
    assert not result.ok and result.error_kind == "invalid_name_guard"
    assert not result.name_guard_applied
    with get_session() as s:
        assert s.exec(select(Review).where(Review.profile_id == pid)).all() == []


def test_bridge_negotiates_and_acknowledges_additive_guard_for_one_sdk_call(host):
    from mcp import Client

    _pid, mcp = host
    set_tool(mcp, lambda _ctx: {"text": L.text(NATIVE_NAME)})
    server = build_server(mcp, "synthetic-name-policy")

    async def exercise():
        async with Client(server) as client:
            assert (
                client.server_capabilities.experimental["cashu/hostPolicyV1"]["nameGuard"] is True
            )
            result = await client.call_tool(
                "mark_review_done",
                {},
                meta={
                    "cashu/privacyCeiling": "strict",
                    "cashu/nameGuard": restriction(strongNames=[NATIVE_NAME]),
                },
            )
            assert not result.is_error and NATIVE_NAME not in result.content[0].text
            assert result.meta["cashu/nameGuardApplied"] is True
            ordinary = await client.call_tool("mark_review_done", {})
            assert NATIVE_NAME in ordinary.content[0].text
            assert "cashu/nameGuardApplied" not in (ordinary.meta or {})

    anyio.run(exercise)


def test_guard_source_limits_count_unicode_codepoints_and_aggregate_utf8_bytes():
    from cashu.core.mcp.host_policy import parse_guard_sources

    assert len(parse_guard_sources(restriction(persons=["x"] * 4096)).persons) == 4096
    assert parse_guard_sources(restriction(persons=["😀" * 2048])).persons == ("😀" * 2048,)
    assert len(parse_guard_sources(restriction(persons=["😀" * 1024] * 256)).persons) == 256


def test_explicit_null_guard_in_actual_wire_request_refuses_before_handler(host):
    _pid, mcp = host
    set_tool(mcp, lambda _ctx: pytest.fail("invalid wire guard reached handler"))
    server = build_server(mcp, "synthetic-invalid-name-policy")
    entry = server._request_handlers["tools/call"]
    params = entry.params_type.model_validate(
        {"name": "mark_review_done", "arguments": {}, "_meta": {"cashu/nameGuard": None}},
        by_name=False,
    )

    async def exercise():
        result = await entry.handler(None, params)
        assert result.is_error and result.meta["cashu/nameGuardApplied"] is False

    anyio.run(exercise)
