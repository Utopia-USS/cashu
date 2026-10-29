# Connector catalog

Community connectors for banks, brokers and exchanges that cashU does not read on its own. Each one is
a normal connector (the contract: [`docs/connectors.md`](../docs/connectors.md)) kept in this repository
so that every cashU install, the downloaded app included, can offer it without a fork or a rebuild.

The catalog is a shelf, not a gate. Nothing here runs by itself: installing an entry copies it into the
app's data dir as `pending`, and the app runs it only after the owner looked at it and approved it in
**Ustawienia > Konektory**, pinned by its content hash. A changed file after the approval stops it until
the owner approves it again. The real check is local: the user's agent installs the connector, tests it
on the user's own export, and the owner approves it in the app.

## Contrib status

Connectors here are **best effort**:

- every connector has a **maintainer** (usually its author, `maintainer` in `connector.yaml`), who keeps
  it working when the bank or broker changes its export or API;
- the core team reviews a connector for safety when it is added or changed (manifest, network hosts,
  what it reads and outputs, synthetic fixtures), not for ongoing correctness;
- a connector whose tests fail, or whose `last_verified` date is older than 180 days, is flagged
  **unmaintained** (the app shows it as stale). The core team does not fix it; its maintainer or any
  other contributor does, with a pull request. An unmaintained connector that stays broken may be
  removed;
- a failing catalog connector never blocks a core pull request: the catalog has its own CI job
  (`connectors-catalog`, informational).

## Layout

```
connectors/
├── README.md                  # this file
└── <id>/                      # the directory name is the manifest id
    ├── connector.yaml         # api_version 1, with maintainer and last_verified (see below)
    ├── connector.py           # the code (any language from the interpreter allowlist)
    ├── README.md              # what it reads, which export or API, how to get the export, limits
    └── fixtures/              # synthetic inputs only, never a real statement (not even redacted)
        └── sample.csv         # file kind: one or more inputs with an extension the manifest lists
                               # fetch kind: one or more recorded synthetic API responses (*.json)
```

Two manifest keys are optional for any connector but **required in the catalog**:

| key | rule |
| --- | --- |
| `maintainer` | who keeps it working: a GitHub handle (`@octocat`) or a name, <= 80 characters |
| `last_verified` | ISO date (`YYYY-MM-DD`) of the last time the maintainer checked it against a real, current export or API |

Every file of the directory is installed and shown to the owner (and covered by the hash), fixtures and
README included. Keep the directory small and readable: the owner reviews it before approving.

[`example-bank-csv/`](example-bank-csv/) is an example entry for a made-up bank; it exists to show the
layout and to exercise the catalog test. Do not install it for real data.

## Adding or updating a connector (pull request checklist)

1. Write it against [`docs/connectors.md`](../docs/connectors.md) and pass its checklist (section 11):
   standard library only, one JSON object on stdout, value-free messages and logs, stable ids,
   `detect` answers `false` for foreign files, fetch connectors honour `HTTPS_PROXY` and read
   `params.fixture`.
2. Put it in `connectors/<id>/` with `connector.yaml`, the code, `README.md` and `fixtures/`.
3. Set `maintainer` (you) and `last_verified` (the day you checked it on a real export or API).
4. Fixtures are synthetic: made-up names, account numbers, amounts and ids. Never commit a real
   statement, API response, key or account number, not even a redacted one.
5. Run the tests locally:

   ```bash
   cashu connectors test connectors/<id> --file connectors/<id>/fixtures/<sample>    # file kind
   cashu connectors test connectors/<id> --fixture connectors/<id>/fixtures/<x>.json # fetch kind
   pytest tests/test_connector_catalog.py
   ```

6. For a `fetch` connector, list only the hosts it needs and say in the README which key it needs and
   that it must be read-only.
7. In the pull request say which bank / broker / exchange and export version you tested with, and
   that the fixtures are synthetic.

Updating an existing connector: bump `version`, refresh `last_verified`, keep the fixtures passing.
Every installed copy of it then shows as `changed` after an update from the catalog, and the owner
approves the new content again.

## How the agent uses it

The user's agent (Claude Code with the profile's MCP server, usually through the `import-builder`
skill) checks the catalog before it writes a new connector:

1. `connectors()` (MCP) lists the installed connectors and the catalog entries (id, name, module, kind,
   version, maintainer, last verified, stale). Without MCP: `cashu connectors catalog list`, which also
   prints where the catalog lives (inside the app bundle for the downloaded app).
2. It tests the entry on the user's export, with the user's consent, in the same sandbox the app uses;
   the report is value-free: `cashu connectors test <catalog dir>/<id> --file <export>`.
3. It installs the entry as `pending`: `propose_connector(catalog_id="<id>")` (MCP) or
   `cashu connectors catalog add <id>`. This never approves and never runs anything.
4. It tells the owner to review and approve it in **Ustawienia > Konektory**. Only the owner approves.

A stale or failing entry is a starting point, not a dead end: the agent can copy it into the profile's
workspace (`connectors/<id>/`), fix it there, test it and propose the fixed copy with
`propose_connector(path=...)`; the fix is worth a pull request here too.
