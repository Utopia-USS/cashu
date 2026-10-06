"""What finanse writes into a workspace: the managed CLAUDE.md sections, the ``.mcp.json`` server
entry and the ``.claude/settings.json`` permission rules. Pure functions of a :class:`Context`, so
the status check and the update compare exactly the same text.

CLAUDE.md is written in English (files for agents), with no profile display name (it may be a
person's name; the slug is already visible to the agent in the MCP tool names).
"""

from __future__ import annotations

import os
import re
import shlex
from dataclasses import dataclass, field
from pathlib import Path, PureWindowsPath

from .skills import SkillSource

BEGIN = "<!-- finanse:begin {name} -->"
END = "<!-- finanse:end {name} -->"
# Managed CLAUDE.md sections, in file order.
SECTIONS = ("profile", "privacy", "tools", "boundaries", "files", "skills", "research")
FOLDERS = ("notes", "research", "scripts", "connectors", "inbox")
INBOX = "inbox"
CONNECTORS = "connectors"
RESEARCH_SKILL = "market-research"
SERVER_PREFIX = "finanse"

USER_PART = """## Your own instructions (not managed)

Write anything else Claude should know about this profile below. finanse never changes text outside
the marked sections.
"""


@dataclass(frozen=True)
class ToolInfo:
    name: str
    module: str
    write: bool


@dataclass(frozen=True)
class Context:
    slug: str
    version: str
    base_currency: str
    privacy: str
    modules: tuple[tuple[str, str], ...]  # (id, Polish name) of the enabled modules, in order
    tools: tuple[ToolInfo, ...]  # core + enabled modules
    skills: dict[str, SkillSource]  # wanted skills (enabled modules)
    research_available: bool  # the market-research skill ships with this version
    cli: tuple[str, ...]  # how to run the finanse CLI (bundled binary or the venv script)
    path: Path  # the workspace
    protected: tuple[Path, ...] = field(default=())  # data dir, DB, import archive (deny rules)
    # Opt-in (default off): the unattended Saturday routine may search the web and write its notes
    # without asking (allow rules for WebSearch, WebFetch, Edit of research/ and notes/).
    routine_permissions: bool = False

    @property
    def server(self) -> str:
        return f"{SERVER_PREFIX}-{self.slug}"

    @property
    def module_ids(self) -> tuple[str, ...]:
        return tuple(m for m, _ in self.modules)

    @property
    def cli_line(self) -> str:
        return shlex.join([*self.cli, "--profile", self.slug])


# --------------------------------------------------------------------------- #
# CLAUDE.md
# --------------------------------------------------------------------------- #


def _section_profile(ctx: Context) -> str:
    modules = ", ".join(f"{name} (`{mid}`)" for mid, name in ctx.modules) or "none (net worth only)"
    update = shlex.join([*ctx.cli, "workspace", "update", "--profile", ctx.slug])
    return f"""## Profile

- finanse profile `{ctx.slug}`. Its data comes only from the MCP server `{ctx.server}`
  (configured in `.mcp.json`).
- Modules enabled: {modules}. Base currency: {ctx.base_currency}.
- finanse CLI for commands the user runs in their own terminal: `{ctx.cli_line} ...`
- Talk to the user in Polish. Files for agents are in English. Regular hyphens only, never the em
  dash character.
- Managed by finanse {ctx.version}. Text between the `finanse:begin` / `finanse:end` markers is
  rewritten by "Aktualizuj workspace" (Ustawienia > Agent AI) or `{update}`.
  Write your own instructions outside the markers."""


def _section_privacy(ctx: Context) -> str:
    if ctx.privacy == "amounts":
        level = (
            "**amounts** (Z kwotami): you also see amounts in the account currency. Still no "
            "account numbers, IBANs or personal data."
        )
    else:
        level = (
            "**strict** (Ścisły, default): you see shares in percent, percentage points, dates, "
            "categories, merchant names and public tickers / ISINs. No amounts, account numbers or "
            "personal names. Do not ask the user for amounts; use relative units (percent of the "
            "portfolio, months of expenses)."
        )
    return f"""## Privacy level

- Level when this file was written: {level}
- The live level is `profile_overview` (`privacy`); when it differs from this file, the live
  level wins.
- In both levels accounts appear as generated labels ("<institution> <type> <n>") and private
  payees as `payee:` references. Every MCP call is logged in the app (Ustawienia > Agent AI).
- The level covers what the app's MCP tools give you. Files or rows the user hands you themselves are
  their choice: use them for the task they asked for."""


def _section_tools(ctx: Context) -> str:
    by_module: dict[str, list[str]] = {}
    for tool in ctx.tools:
        label = f"`{tool.name}`" + (" (write)" if tool.write else "")
        by_module.setdefault(tool.module, []).append(label)
    order = ["core", *ctx.module_ids]
    lines = [f"- {m}: {', '.join(by_module[m])}" for m in order if m in by_module]
    tools = "\n".join(lines) or "- (none)"
    return f"""## MCP tools (server `{ctx.server}`)

Use only this server, never another profile's.

{tools}

Write tools record a decision, thesis, note or category, or store a proposal the owner approves in
the app. The list follows the enabled modules; `.claude/settings.json` allows exactly these tools."""


def _section_boundaries(ctx: Context) -> str:
    places = "\n".join(f"  - `{p}`" for p in ctx.protected)
    return f"""## Boundaries

- Data only through the MCP tools above. Never read, list, copy or parse these places of the app
  (finanse data dir, database, backups, import archive):
{places}
  `.claude/settings.json` denies Claude Code's file tools there. Bash commands ask the user
  first: never propose one that reads those places.
- Files in `{INBOX}/` are the user's: open one when the user hands it to you or asks you to. Do not
  copy its values into `notes/`, memory, scripts or git; keep them in the conversation. Account
  numbers, IBANs and names you see there are never repeated or written anywhere.
- Never run finanse CLI commands that print personal data (`stats`, `accounts`, `import-dir`,
  `import-csv`, `invest positions`, `invest import`, `loans list`, `eb login|check|sessions|resync`).
  Give them to the user to run in their own terminal, not with `!` in this session.
- Not a licensed advisor. Model recommendations are opinions for the owner to evaluate, never
  decisions or orders. No price predictions. Facts that change are looked up online with a source;
  never bypass paywalls, logins or bot protection.
- Never ask for passwords, logins, SCA / 2FA codes, API keys, IBANs or account numbers. If the user
  pastes one, do not repeat or store it.
- Personal or financial data never goes into git repositories, memory files or code; working notes
  stay in this workspace."""


def _section_files(ctx: Context) -> str:
    return f"""## Where things go

- `notes/`: working notes (interview state, situation, retrospective, special situations;
  `/investments-setup` uses `notes/interview/`). English; in strict mode relative values only,
  unless the user agreed to note amounts.
- `research/`: working files of research runs (source lists, drafts). Results go to the app with
  the research MCP tools.
- `scripts/`: converters and helper scripts you write (Python standard library only). You run them
  with a Bash command the user approves; the app never runs them.
- `{CONNECTORS}/`: connectors you write (`{CONNECTORS}/<id>/`; the contract is
  `.claude/skills/import-builder/references/connectors.md`); `propose_connector` submits one. The app
  runs one only after the owner approves it in Ustawienia > Konektory.
- `{INBOX}/`: the user saves exports here (renamed if the file name holds an account number). Open
  one when the user hands it to you; with the blind route `inspect_export` shows its masked
  structure. Converter output goes to `{INBOX}/converted/` and is deleted after the owner commits the
  import.
- `.claude/skills/`: the skills finanse manages (below) plus your own skills, which finanse never
  touches."""


def _section_skills(ctx: Context) -> str:
    if not ctx.skills:
        listed = "- (none for the enabled modules)"
    else:
        listed = "\n".join(f"- `/{s.name}` ({s.module})" for s in ctx.skills.values())
    return f"""## Skills

Managed by finanse for the enabled modules (a skill of a module you switch off is removed on the
next update; a managed skill you edited is kept and reported instead of being replaced):

{listed}"""


def _section_research(ctx: Context) -> str:
    if "investments" not in ctx.module_ids:
        return "## Weekly research\n\nThe investments module is off for this profile: no research routine."
    if not ctx.research_available:
        return "## Weekly research\n\nThe market research skill is not part of this finanse version yet."
    if ctx.routine_permissions:
        unattended = (
            "**on**.\n  Web searches, web pages and writes to `research/` and `notes/` run without a"
            " prompt\n  (`.claude/settings.json`), so an unattended run can finish."
        )
    else:
        unattended = (
            "**off**.\n  Every web search, web page and file write asks first, so an unattended run"
            " stops at\n  the first prompt; the user can switch it on in Ustawienia > Agent AI."
        )
    return f"""## Weekly research

- Run `/market-research` on Saturday, before the Sunday review, or whenever the user asks.
  Scope: held positions, the watchlist, candidates matching the strategy, sector and macro trends.
  Results go to the app as notes with sources through the research MCP tools.
- The Saturday run is a LOCAL routine in this folder (the finanse MCP server runs on this Mac;
  `/schedule` creates cloud routines that cannot reach it): Claude desktop app > Code > Routines >
  New routine > Local, weekly, Saturday 07:00, folder = this workspace, instructions
  `/market-research rutyna`. Alternative for terminal users: a LaunchAgent the user installs that runs
  `{claude_command(ctx.path, "/market-research rutyna")}`.
  Set it up only after the user approves the schedule; never silently.
- Unattended permissions (opt-in, Ustawienia > Agent AI): {unattended}
- Research notes contain facts and sentiment with sources only (community sentiment flagged as
  noisy). Recommendations are saved separately and never place trades. No price predictions;
  never bypass paywalls or bot protection."""


def claude_command(path: Path, prompt: str | None = None) -> str:
    """``cd <path> && claude`` (with ``-p "<prompt>"`` for a headless run)."""
    tail = f" -p {shlex.quote(prompt)}" if prompt else ""
    return f"cd {shlex.quote(str(path))} && claude{tail}"


_RENDER = {
    "profile": _section_profile,
    "privacy": _section_privacy,
    "tools": _section_tools,
    "boundaries": _section_boundaries,
    "files": _section_files,
    "skills": _section_skills,
    "research": _section_research,
}


def sections(ctx: Context) -> dict[str, str]:
    return {name: _RENDER[name](ctx) for name in SECTIONS}


def _block(name: str, text: str) -> str:
    return f"{BEGIN.format(name=name)}\n{text}\n{END.format(name=name)}"


def _pattern(name: str) -> re.Pattern[str]:
    return re.compile(
        re.escape(BEGIN.format(name=name)) + r"\n?(.*?)\n?" + re.escape(END.format(name=name)),
        re.DOTALL,
    )


def read_sections(text: str) -> dict[str, str]:
    """The managed sections present in a CLAUDE.md (name -> inner text)."""
    out = {}
    for name in SECTIONS:
        m = _pattern(name).search(text)
        if m:
            out[name] = m.group(1)
    return out


def new_claude_md(ctx: Context) -> str:
    blocks = "\n\n".join(_block(n, t) for n, t in sections(ctx).items())
    return f"# finanse agent workspace\n\n{blocks}\n\n{USER_PART}"


def merge_claude_md(existing: str | None, ctx: Context) -> str:
    """Replace the managed sections of ``existing`` and add the missing ones; every other line
    stays as the user wrote it."""
    if existing is None:
        return new_claude_md(ctx)
    text = existing
    wanted = sections(ctx)
    last_end = -1  # end offset of the last managed section seen, in SECTIONS order
    for name in SECTIONS:
        block = _block(name, wanted[name])
        m = _pattern(name).search(text)
        if m:
            text = text[: m.start()] + block + text[m.end() :]
            last_end = m.start() + len(block)
            continue
        if last_end >= 0:
            insert = "\n\n" + block
            text = text[:last_end] + insert + text[last_end:]
            last_end += len(insert)
        else:
            # No managed section before this one: at the top, below a leading "# " title.
            first = text.split("\n", 1)
            if first[0].startswith("# "):
                head = first[0] + "\n\n"
                rest = first[1].lstrip("\n") if len(first) > 1 else ""
            else:
                head, rest = "", text
            insert = block + "\n\n"
            text = head + insert + rest
            last_end = len(head) + len(block)
    return text if text.endswith("\n") else text + "\n"


# --------------------------------------------------------------------------- #
# .mcp.json and .claude/settings.json
# --------------------------------------------------------------------------- #


def mcp_entry(ctx: Context) -> dict:
    return {"command": ctx.cli[0], "args": [*ctx.cli[1:], "mcp", "--profile", ctx.slug]}


def is_finanse_server(name: str) -> bool:
    return name == SERVER_PREFIX or name.startswith(SERVER_PREFIX + "-")


def merge_mcp(existing: dict | None, ctx: Context) -> dict:
    """Only this profile's finanse server (other profiles' servers are dropped); servers the user
    added that are not finanse servers stay."""
    data = dict(existing or {})
    servers = data.get("mcpServers")
    servers = dict(servers) if isinstance(servers, dict) else {}
    kept = {k: v for k, v in servers.items() if not is_finanse_server(k)}
    data["mcpServers"] = {ctx.server: mcp_entry(ctx), **kept}
    return data


def rule_path(path: Path) -> str:
    """A Claude Code permission path for an absolute path: ``//`` + the POSIX form
    (``//Users/x/...``; on Windows ``//c/Users/x/...``)."""
    raw = str(path)
    if os.name == "nt" or PureWindowsPath(raw).drive:
        win = PureWindowsPath(raw)
        drive = win.drive.rstrip(":").lower()
        rest = "/".join(win.parts[1:])
        return f"//{drive}/{rest}" if drive else "//" + rest
    return "/" + path.as_posix()


def allow_rules(ctx: Context) -> list[str]:
    return [f"mcp__{ctx.server}__{t.name}" for t in ctx.tools]


def routine_rules(ctx: Context) -> list[str]:
    """Allow rules of the opt-in unattended routine (an ``Edit`` rule also covers ``Write``); none
    while the investments module (the routine's module) is off, the stored choice stays."""
    if not ctx.routine_permissions or "investments" not in ctx.module_ids:
        return []
    return [
        "WebSearch",
        "WebFetch",
        f"Edit({rule_path(ctx.path / 'research')}/**)",
        f"Edit({rule_path(ctx.path / 'notes')}/**)",
    ]


def deny_rules(ctx: Context) -> list[str]:
    """Read / Edit denied in the app's places only (``inbox/`` is the user's drop folder: not denied
    since F10 11.3; the agent opens a file there when the user hands it over)."""
    out: list[str] = []
    for place in ctx.protected:
        p = rule_path(place)
        for tool in ("Read", "Edit"):
            out.append(f"{tool}({p}/**)")
    return out


def legacy_deny_rules(ctx: Context) -> list[str]:
    """Deny rules finanse wrote before and no longer wants (the ``inbox/`` rules before F10): removed
    on update even when the workspace manifest does not list them."""
    p = rule_path(ctx.path / INBOX)
    return [f"Read({p}/**)", f"Edit({p}/**)"]


def is_managed_rule(rule: str, server_names: tuple[str, ...] = ()) -> bool:
    """A finanse MCP allow rule (any profile: a copied workspace must not keep another profile's)."""
    return rule.startswith(f"mcp__{SERVER_PREFIX}-") or any(
        rule.startswith(f"mcp__{s}__") for s in server_names
    )


def _allow_list(existing: dict | None) -> list[str]:
    perms = (existing or {}).get("permissions")
    allow = perms.get("allow") if isinstance(perms, dict) else None
    return [r for r in allow if isinstance(r, str)] if isinstance(allow, list) else []


def routine_owned(existing: dict | None, ctx: Context, previous_routine: list[str]) -> list[str]:
    """The routine rules finanse adds (and may remove later): those the user did not have already."""
    user = [
        r for r in _allow_list(existing) if not is_managed_rule(r) and r not in previous_routine
    ]
    return [r for r in routine_rules(ctx) if r not in user]


def merge_settings(
    existing: dict | None,
    ctx: Context,
    previous_deny: list[str],
    previous_routine: list[str] | None = None,
) -> dict:
    """Our allow / deny rules and approved server merged into the user's settings: finanse MCP allow
    rules, our previous deny rules and our previous routine rules are replaced, everything else the
    user wrote stays (a rule the user added by hand is never removed unless finanse added it)."""
    data = dict(existing or {})
    perms = data.get("permissions")
    perms = dict(perms) if isinstance(perms, dict) else {}

    def as_list(value) -> list[str]:
        return [v for v in value if isinstance(v, str)] if isinstance(value, list) else []

    ours = allow_rules(ctx) + routine_rules(ctx)
    old_routine = previous_routine or []
    allow = [
        r
        for r in as_list(perms.get("allow"))
        if not is_managed_rule(r) and r not in old_routine and r not in ours
    ]
    want_deny = deny_rules(ctx)
    dropped = set(previous_deny) | set(legacy_deny_rules(ctx))
    deny = [r for r in as_list(perms.get("deny")) if r not in dropped and r not in want_deny]
    perms["allow"] = ours + allow
    perms["deny"] = want_deny + deny
    data["permissions"] = perms
    servers = [s for s in as_list(data.get("enabledMcpjsonServers")) if not is_finanse_server(s)]
    data["enabledMcpjsonServers"] = [ctx.server, *servers]
    return data
