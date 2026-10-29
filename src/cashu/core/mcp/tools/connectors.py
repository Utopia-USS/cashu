"""Connector MCP tools (module-agnostic, F10): ``propose_connector`` and ``connectors``.

The rule: the app runs a connector only after the owner approves it in the app (Ustawienia > Konektory),
pinned by its content hash, in a sandbox, with a timeout. An MCP call never runs code and can never
approve: ``propose_connector`` installs a copy as ``pending`` (or, for an installed connector, replaces it
so it waits for approval again); validating the manifest resolves the interpreter path but starts
nothing. ``connectors`` lists what is installed with run outcomes and error kinds only: never a
connector's message, its stderr, binding params or secrets (those stay in the owner's app).

The connector catalog shipped with the app (``core/connectors/catalog.py``, the repository's
``connectors/``) is listed by ``connectors`` too (public facts only: id, name, module, kind, version,
maintainer, last verified, stale, valid, the installed status). ``propose_connector(catalog_id=...)``
installs an entry exactly like a workspace directory: pending, never approved, nothing run.
"""

from __future__ import annotations

from sqlmodel import col, func, or_, select

from .. import labels as L
from ..registry import ToolContext, ToolError, ToolSpec

CONNECTORS_FOLDER = "connectors"
RULE = (
    "The app runs a connector only after the owner approves it in the app (Ustawienia > Konektory); "
    "MCP calls never run code and never approve."
)
CATALOG_NOTE = (
    "catalog: community connectors shipped with the app (best effort, each with a maintainer; stale = "
    "not verified for 180 days, treat as unmaintained). Check it before writing a new connector; "
    "install an entry for the owner's review with propose_connector(catalog_id=...)."
)


def _workspace_connectors(slug: str):
    from cashu.core.workspace import service as workspace

    return workspace.workspace_path(slug) / CONNECTORS_FOLDER


def propose_connector(
    ctx: ToolContext, path: str | None = None, catalog_id: str | None = None
) -> dict:
    from cashu.core.connectors import manifest as mf
    from cashu.core.connectors import service

    from .exports import checked_local_dir

    if (path is None) == (catalog_id is None):
        raise ToolError("give either path (a workspace connector) or catalog_id (a catalog entry)")
    if catalog_id is not None:
        installed = _install_from_catalog(catalog_id)
    else:
        folder = checked_local_dir(path, _workspace_connectors(ctx.profile.slug))
        try:
            manifest = mf.load_dir(folder).manifest  # validation only: resolves paths, runs nothing
        except mf.ManifestError as e:
            raise ToolError(_issues("the connector is not valid", e.issues)) from None
        if manifest.id != folder.name:
            raise ToolError(
                f"the directory name must be the connector id: connectors/{manifest.id}/", "invalid"
            )
        try:
            installed = service.install(folder, replace=True, source="mcp")
        except service.ConnectorError as e:
            raise ToolError(_issues(str(e), e.issues)) from None
    row = installed.connector
    m = service.manifest_of(row)
    return {
        "id": L.category(row.id),
        "status": L.category(row.status),
        "replaced": L.flag(installed.replaced),
        "content_sha256": L.text(row.content_sha256[:12]),
        "module": L.category(row.module),
        "kind": L.category(row.kind),
        "hosts": [L.text(h) for h in m.hosts],
        "secret_ids": [L.category(s) for s in m.secret_ids],
        "note": L.text(
            "installed for review; " + RULE + " Tell the owner to review and approve it there."
            + (" For a fetch connector the owner enters the keys in the app." if row.kind == "fetch"
               else "")
        ),
    }


def _install_from_catalog(catalog_id: str):
    """The catalog entry installed through the same ``service.install`` as a workspace directory
    (replacing an installed copy of that id, like ``propose_connector(path)``)."""
    from cashu.core.connectors import catalog, service

    try:
        return catalog.install(catalog_id, replace=True, source="mcp")
    except service.NotFound:
        raise ToolError(
            "no catalog connector with that id (connectors() lists the catalog)", "not_found"
        ) from None
    except service.ConnectorError as e:
        raise ToolError(_issues(str(e), e.issues)) from None


def _catalog(ctx: ToolContext) -> list[dict]:
    from cashu.core.connectors import catalog

    rows = catalog.installed_rows(ctx.session)
    items = []
    for entry in catalog.list_entries(today=ctx.today):
        m = entry.manifest
        row = rows.get(entry.id)
        items.append(
            {
                "id": L.category(entry.id),
                "name": L.text(m.name if m else None),
                "module": L.category(m.module if m else None),
                "kind": L.category(m.kind if m else None),
                "version": L.text(m.version if m else None),
                "maintainer": L.text(m.maintainer if m else None),
                "last_verified": L.date(m.last_verified if m else None),
                "stale": L.flag(entry.stale(ctx.today)),
                "valid": L.flag(entry.valid),
                "installed_status": L.category(row.status if row is not None else None),
                "installed_same_content": L.flag(
                    row.content_sha256 == entry.content_sha256 if row is not None else None
                ),
            }
        )
    return items


def _issues(message: str, issues) -> str:
    shown = list(issues)[:8]
    more = f" (+{len(issues) - 8} more)" if len(issues) > 8 else ""
    return f"{message}: {'; '.join(shown)}{more}" if shown else message


def connectors(ctx: ToolContext) -> dict:
    from cashu.core.connectors import service
    from cashu.core.connectors.models import Connector, ConnectorBinding, ConnectorRun

    s = ctx.session
    counts = dict(
        s.exec(
            select(ConnectorBinding.connector_id, func.count())
            .where(ConnectorBinding.profile_id == ctx.profile_id)
            .group_by(ConnectorBinding.connector_id)
        ).all()
    )
    items = []
    for row in s.exec(select(Connector).order_by(Connector.id)).all():
        service.refresh(s, row)
        last = s.exec(
            select(ConnectorRun)
            .where(
                ConnectorRun.connector_id == row.id,
                # this profile's runs, or the developer's test runs (no profile); never another's
                or_(ConnectorRun.profile_id == ctx.profile_id, col(ConnectorRun.profile_id).is_(None)),
            )
            .order_by(col(ConnectorRun.id).desc())
            .limit(1)
        ).first()
        items.append(
            {
                "id": L.category(row.id),
                "name": L.text(row.name),
                "module": L.category(row.module),
                "kind": L.category(row.kind),
                "status": L.category(row.status),
                "last_run": None
                if last is None
                else {
                    "command": L.category(last.command),
                    "outcome": L.category(last.outcome),
                    "error_kind": L.category(last.error_kind),
                    "at": L.date(last.started_at),
                    "records": L.count(last.records),
                },
                "bindings": L.count(int(counts.get(row.id, 0))),
            }
        )
    return {
        "connectors": items,
        "catalog": _catalog(ctx),
        "catalog_note": L.text(CATALOG_NOTE),
        "rule": L.text(RULE),
    }


TOOLS = (
    ToolSpec(
        "propose_connector",
        "core",
        "Submit a connector for the owner's review: `path` = a connector you wrote (a directory "
        "connectors/<id>/ in this workspace with connector.yaml and its code; the contract is the "
        "import-builder skill's references/connectors.md), or `catalog_id` = an entry of the connector "
        "catalog shipped with the app (listed by connectors()). It is "
        "installed as pending (an installed one is replaced and waits for approval again). " + RULE
        + " Returns id, status, hash prefix, module, kind, allowed hosts and secret ids. Test it before "
        "with `cashu connectors test <dir> --file <export>`. Never ask for API keys: the owner enters "
        "them in the app.",
        propose_connector,
        properties={
            "path": {"type": "string", "maxLength": 1024},
            "catalog_id": {"type": "string", "maxLength": 40},
        },
        write=True,
        refused={
            "converter": "propose_connector takes the connector directory only; nothing is run",
            "approve": "only the owner approves a connector, in the app (Ustawienia > Konektory)",
        },
    ),
    ToolSpec(
        "connectors",
        "core",
        "Installed connectors: id, name, module, kind, status (pending / approved / changed / "
        "disabled), the last run's outcome, error kind and time, and how many accounts of this profile "
        "use each; and the connector catalog shipped with the app (id, name, module, kind, version, "
        "maintainer, last verified, stale, valid, installed status). Run messages, logs, parameters "
        "and keys stay in the app. " + RULE,
        connectors,
    ),
)
