<!-- Copy shipped with this skill, generated from the cashU sources; do not edit it here. -->

# cashU connectors (api_version 1)

The contract for anyone who writes a connector for cashU (cashU): a person, or more often their
agent (Claude Code). Read it whole before you start; it is short on purpose. Working examples:
[`connector-examples/`](connector-examples/). JSON Schemas: [`schemas/`](schemas/).

cashU ships few importers of its own. Instead, anyone can write a small **connector** in any language,
drop it in, and the owner approves it once in the app. From then on the app runs it itself to read
exports or pull data from an API. No fork, no rebuild.

The rule behind it: **the app runs only a connector the owner approved in the app, pinned by content
hash, out of process, in a sandbox, with a timeout.** An agent (MCP) can install a connector as
pending, but it can never approve one and never make the app run code.

## 1. What a connector is

A directory with a manifest `connector.yaml` and code. Two kinds:

| kind | what it does | commands | network |
| --- | --- | --- | --- |
| `file` | converts an export file the owner imports (CSV, XLSX, JSON, ...) | `detect`, `convert` | none |
| `fetch` | pulls data from a broker / exchange / bank API with a key the owner enters in the app | `fetch`, `check` | only the manifest's hosts, port 443, through the app's proxy |

and two modules: `investments` (the output is a `cashu-import` document) and `budget` (a
`cashu-budget-import` document). A connector never writes anything itself: its output goes through the
same validation, preview and deduplication as any import, and the owner commits it (section 9 for the
fetch auto-commit rule).

The installed copy lives in the app's data dir, `connectors/<id>/` (one per installation, shared by all
profiles: it is code, not data). Every run is one process: one JSON request on stdin, one JSON response
on stdout.

## 2. Manifest `connector.yaml`

```yaml
api_version: 1
id: examplebank-csv              # ^[a-z][a-z0-9-]{1,39}$, unique per installation
name: Przykładowy Bank CSV       # shown to the owner, <= 60 characters
version: 1.0.0                   # free text, <= 20 characters, shown only
author: Jan Kowalski             # optional, <= 80 characters
description: Wyciąg CSV ...      # optional, <= 280 characters
module: budget                   # investments | budget
kind: file                       # file | fetch
run: [python3, connector.py]     # argv, see below
timeout_s: 60                    # 1..600, default 60 (detect always 10)
file:                            # kind file only (and required for it)
  extensions: [csv]              # 1..20, lower case, no dot, ^[a-z0-9]{1,10}$
# fetch:                         # kind fetch only (and required for it)
#   hosts: [api.example.com]     # 1..10 exact host names, port 443 only
#   secrets:                     # 0..5, entered by the owner, stored in the macOS keychain
#     - {id: api_key, label: Klucz API (tylko odczyt)}
#   params:                      # 0..10 non-secret settings per binding
#     - {id: start, label: Od daty, type: date, required: false}
#   history_days: 365            # 1..3650, default 365: how far back the first fetch goes
```

| key | rule |
| --- | --- |
| `api_version` | the number `1` |
| `id` | `^[a-z][a-z0-9-]{1,39}$`; installing another connector with the same id needs `--replace` |
| `name`, `version` | required, non-empty, <= 60 / <= 20 characters |
| `author`, `description` | optional, <= 80 / <= 280 characters |
| `module`, `kind` | see above; `kind: file` needs a `file` section and no `fetch` section, and the other way round |
| `run` | 1..8 plain strings, each <= 200 characters, no control characters, no `..` path segment, no absolute or `~` paths. No shell: it is an argv, not a command line. An argument that names a file of the connector (`connector.py`) is passed as that file's absolute path, because the process runs in another directory (section 4) |
| `run[0]` | an interpreter name from the allowlist `python3`, `node`, `deno`, `bun`, `ruby`, `perl`, or `./<file>`: an executable file inside the connector directory (covered by the hash) |
| `timeout_s` | wall clock limit of `convert`, `fetch`, `check`; `detect` always has 10 s |
| `file.extensions` | the file extensions the connector reads; the app offers it only for those |
| `fetch.hosts` | exact lower-case DNS names with a letter in the last label: no scheme, port, path, wildcard, IP address or `localhost` |
| `fetch.secrets[]` | `id` `^[a-z][a-z0-9_]{0,31}$`, `label` <= 60 characters; unique ids |
| `fetch.params[]` | `id` as above, `label` <= 60, `type` `string` (default) / `date` / `number` / `boolean`, `required` (default `false`); unique ids |

- Unknown keys are errors (with a "did you mean" hint), at every level. The manifest is at most 64 KiB.
- `name` and the `label`s are shown to the owner verbatim; the app's UI is Polish, so write them in Polish.
- Schema: [`schemas/connector-manifest.v1.json`](schemas/connector-manifest.v1.json) (the app also checks
  what a schema cannot express: `run`, the matching section, unique ids, the directory rules).

**Directory rules.** At most 200 regular files and 5 MiB in total; `connector.yaml` at the top; no
symlinks, no special files, no hidden files except `.gitignore`, UTF-8 file names. Subdirectories are
fine. Keep test inputs synthetic: every file of the directory is installed and shown to the owner.

**Content hash.** `content_sha256` = sha256 over the sorted lines `<relative path>\0<sha256 of the
file>\n` of every file. The owner approves this hash. Changing any file (also the README) after the
approval stops the connector until the owner approves it again.

**Interpreter resolution.** An interpreter name is looked up (`which`) on a fixed search path, never the
user's `PATH`: `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`, then `~/.local/bin` and
`~/.nvm/current/bin` when they exist. A `#!` script found there (a version-manager shim or wrapper) is
skipped for the next match: it cannot run in the sandbox. The result is resolved to its real path, shown
at approval and pinned: when the same name later resolves to another path (an upgrade, another
install), the connector is `changed` and needs a new approval. The interpreter is pinned by its path,
not by its content: replacing the binary at that same path (e.g. a Homebrew upgrade in place) is not
detected. Hashing a whole interpreter installation is impractical, and replacing it needs write access to
the machine already, so this is accepted by design.

- Apple's `/usr/bin/python3` is an `xcrun` shim that cannot start inside the sandbox; when it is the one
  found, the app pins the real `python3` of the active developer directory instead
  (`/Library/Developer/CommandLineTools/usr/bin/python3` or the Xcode one). Without the developer tools
  (`xcode-select --install`) install Python another way (Homebrew).
- Version-manager shims (`~/.pyenv/shims`, rbenv, asdf) are not searched: they are shell scripts that
  need the manager's state. Prefer a Homebrew or Apple `python3`.
- Write for an old `python3` too (Apple's is 3.9): no `match`, no `X | Y` annotations at runtime.

## 3. Protocol

**Request** (stdin, one UTF-8 JSON object; schema
[`schemas/connector-protocol.v1.json`](schemas/connector-protocol.v1.json)):

```json
{"api_version": 1, "command": "convert", "module": "budget",
 "file": {"path": "/.../tmp/connectors/<run id>/input.csv", "name": "historia.csv"},
 "account": {"currency": "PLN", "label": "mBank osobiste 1"},
 "params": {"start": "2025-01-01"},
 "secrets": {"api_key": "..."},
 "since": "2025-10-01", "cursor": null}
```

| key | when | meaning |
| --- | --- | --- |
| `api_version`, `command`, `module` | always | `command`: `detect` / `convert` (file), `fetch` / `check` (fetch) |
| `file` | detect, convert | `path`: a copy of the input inside the run directory (`input.<ext>`); `name`: the original file name. The original location is never given |
| `account` | when known | the target account: `currency` (ISO 4217) and its display `label`. May be absent (developer tests, auto-detect) |
| `params` | always (may be `{}`) | the binding's params (fetch); `connectors test` adds `fixture` (section 6) |
| `secrets` | fetch, check | the binding's secrets by id |
| `since` | fetch | `YYYY-MM-DD`: the day of the last fetch whose import was committed, or `history_days` back before the first commit |
| `cursor` | fetch (always present) | your own opaque string from the previous `fetch`, or `null` |

Ignore keys you do not know: later api versions only add keys.

**Responses** (stdout, one UTF-8 JSON object, at most 64 MiB, exit code 0):

| command | response |
| --- | --- |
| `detect` | `{"match": true, "confidence": 0.9}`: does this file look like yours? `confidence` 0..1 (default 1). Never fail on a foreign file: answer `{"match": false, "confidence": 0}` |
| `convert` | `{"document": {...}}`: the import document (section 5). No `cursor` |
| `fetch` | `{"document": {...}, "cursor": "..."}`: `cursor` optional, <= 4096 characters, opaque to the app |
| `check` | `{"ok": true}`: the credentials work and the API is reachable. Fetch no data |

Responses are strict: unknown keys, wrong types (`"true"` for `true`) or extra output on stdout make the
run fail with `protocol`. Print nothing else on stdout.

**Errors.** Exit code 1 with `{"error": {"kind": "<kind>", "message": "<text>"}}` on stdout. Kinds:

| kind | use it for |
| --- | --- |
| `bad_file` | the file is not what you expect (wrong export, broken row, unknown label) |
| `unsupported_version` | a request `api_version` or an export version you do not support |
| `auth_failed` | the API refused the key |
| `rate_limited` | the API asked to slow down (the app waits 48 h before the next automatic fetch) |
| `network` | the host cannot be reached |
| `upstream` | the API answered with an error or an unexpected shape |
| `internal` | anything else (an unknown kind is recorded as `internal`) |

`message` (<= 500 characters kept) is shown to the owner only, never to an agent (section 10). The app
assigns its own kinds: `protocol` (any exit code other than 0 / 1, invalid JSON, wrong shape, oversize
output), `timeout`, `sandbox_unavailable`, `spawn_failed`, `not_approved`, `interpreter_changed`,
`missing`, `bad_request`.

**stderr** is a free log. The app keeps its last 64 KiB in memory and stores a 4 KiB tail with the
secrets and anything that looks like an account number, amount or e-mail redacted; only the owner sees
it. Log counts and steps, never values.

## 4. Where and how it runs

| | |
| --- | --- |
| cwd, `HOME`, `TMPDIR` | a fresh private run directory under the data dir, deleted after the run |
| code | a private copy of the installed connector made for this run, outside the run directory; the app hashes the copy and runs it only when the hash and the interpreter equal the approval (a file changed after the check never runs); deleted after the run |
| environment | exactly `PATH=/usr/bin:/bin:<dir of the interpreter>`, `HOME`, `TMPDIR`, `LANG=LC_ALL=C.UTF-8`, `PYTHONDONTWRITEBYTECODE=1`, `PYTHONNOUSERSITE=1`, `CASHU_CONNECTOR_API=1` (and the deprecated `FINANSE_CONNECTOR_API=1`, the legacy name, for one more release); fetch runs also `HTTPS_PROXY=HTTP_PROXY=http://127.0.0.1:<port>` and an empty `NO_PROXY`. Nothing is inherited |
| time | `detect` 10 s, other commands `timeout_s`; then the whole process group gets SIGTERM and, 2 s later, SIGKILL. CPU time is limited to the timeout + 5 s |
| size | the input file <= 64 MiB; any file you write <= 128 MiB; stdout <= 64 MiB |

**Sandbox** (macOS `sandbox-exec`, deny by default). In plain words:

- **Reads:** system locations (`/usr`, `/bin`, `/System`, `/private/etc`, `/opt/homebrew`, `/dev/null`,
  `/dev/urandom`), the interpreter's own installation, the connector's directory and the run directory.
  **Not** `/Library`, the user's home, Documents, Desktop, the cashU data dir or database, other
  connectors, the keychains or the clipboard.
- **Writes:** only the run directory (and `/dev/null`). Use it for temporary files; it is deleted after
  the run, so nothing survives between runs except the `cursor` you return.
- **Processes:** the interpreter and executables inside the connector directory. No shell, no other
  programs (`/bin/sh`, `curl`, `git` are denied).
- **Network:** a `file` connector has none at all (no DNS either). A `fetch` connector can reach only the
  app's egress proxy on `127.0.0.1`.
- On anything but macOS no connector runs (`sandbox_unavailable`); there is no unsandboxed mode.

**Network for fetch connectors.** The proxy (HTTP `CONNECT`) allows a tunnel only to a host listed in
`fetch.hosts`, port 443, when that name resolves to public addresses only (DNS cannot point a connector at
the machine itself or the LAN). Everything else gets `403` and the refused host name is shown to the
owner in the run history. Plain HTTP is refused. TLS stays end to end: the proxy sees only the host
name; it counts bytes in and out. Redirects to a host not in the list fail.

Your HTTP client must use `HTTPS_PROXY`; a connector that ignores it cannot reach the network at all.

- Python: `urllib.request` reads it from the environment (or pass it explicitly as in the fetch example);
  `requests` and `httpx` read it too.
- Node: `http`, `https` and `fetch` ignore it. Open the tunnel yourself (standard library only):

```js
const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');

// GET https://<host>/... through the app's egress proxy.
function get(url, headers = {}) {
  const target = new URL(url);
  const proxy = new URL(process.env.HTTPS_PROXY);
  const authority = `${target.hostname}:443`;
  return new Promise((resolve, reject) => {
    const tunnel = http.request({ host: proxy.hostname, port: proxy.port, method: 'CONNECT',
                                  path: authority, headers: { host: authority } });
    tunnel.on('error', reject);
    tunnel.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return reject(new Error(`proxy refused the host (${res.statusCode})`));
      }
      const req = https.request({
        host: target.hostname, path: target.pathname + target.search, method: 'GET', headers,
        // no `agent` option: with one, Node ignores createConnection and resolves DNS itself
        createConnection: () => tls.connect({ socket, servername: target.hostname }),
      }, (response) => {
        const chunks = [];
        response.on('data', (c) => chunks.push(c));
        response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks) }));
      });
      req.on('error', reject);
      req.end();
    });
    tunnel.end();
  });
}
```

## 5. Output formats

The `document` of `convert` / `fetch` is the JSON variant of the module's import format:

- `investments`: `cashu-import` v1, [`import-format.md`](import-format.md) (section 2.2 for JSON);
  schema [`schemas/cashu-import.v1.json`](schemas/cashu-import.v1.json).
- `budget`: `cashu-budget-import` v1, [`budget-import-format.md`](budget-import-format.md); schema
  [`schemas/cashu-budget-import.v1.json`](schemas/cashu-budget-import.v1.json).

The import keeps the formats' rules: exact decimal strings, ISO dates, outflows negative, unknown fields
refused. Two rules matter most for connectors that run again and again:

- **Stable ids.** Fill `external_ref` (investments) / `transaction_id` (budget) only with the source's
  own stable id, never a row number or counter. Re-importing an overlapping period is then harmless.
- **Deterministic.** The same input gives the same document. A fetch may return records that were
  already imported (they are deduplicated); it must never skip records.

The document's `source` becomes the batch's source label (`[a-z][a-z0-9_]`, <= 32 characters; keep it
the same for every run).

## 6. Testing: `cashu connectors test`

Run your connector exactly as the app does, in the same sandbox, also before it is installed or
approved:

```bash
cashu connectors test connectors/<id> --file inbox/<export>          # file kind: detect + convert
cashu connectors test connectors/<id> --fixture connectors/<id>/fixture.json   # fetch kind, offline
cashu connectors test connectors/<id> --check-manifest                # manifest and directory only
cashu connectors test connectors/<id> --file <export> --module budget # also check the module
```

The report is **value-free**: manifest facts, the interpreter, the hash, each command's outcome and
time, then the import validation as counts per record kind and type, and problems by kind with row
numbers and field names. It never prints a value from the file, the document, your error message or
stderr, so an agent can run it on the user's real export. Exit code 0 = everything OK. Example:

```
manifest: OK (budget-csv-example 1.0.0, module budget, kind file)
  interpreter: /opt/homebrew/Cellar/python@3.14/.../bin/python3.14
  content sha256: 0163...
  extensions: csv
detect: ok (77 ms)
  match: yes (confidence 0.95)
convert: ok (75 ms)
document: OK (cashu-budget-import)
  cashu-budget-import v1 (json): OK, 4 transactions, 0 balances
```

**Fetch connectors are tested offline.** `--fixture <file>` runs `fetch` with no network and the
fixture file's text (a recorded or synthetic API response, JSON, <= 1 MiB) as `params.fixture`; every
declared secret is set to the placeholder `test-not-a-real-secret`. The test never uses real secrets.
Make your connector answer from `params.fixture` when it is present (see
[`connector-examples/fetch-example`](connector-examples/fetch-example)) and do **not** declare
`fixture` in the manifest: a binding then can never set it, so a fixture can only reach the code in a
test. `check` and the real network are tried in the app (`Sprawdź połączenie`) once the owner approved
the connector and entered the key.

Test runs are recorded in the connector's run log without a profile.

## 7. Installing

- CLI: `cashu connectors add <dir>` copies the directory into the data dir and installs it as
  `pending`. `--replace` updates an installed connector of the same id: it keeps its bindings; an
  approved one becomes `changed` unless the content is identical. Changing `module` or `kind` needs
  `remove` first.
- Agent: the MCP write tool `propose_connector(path)` does the same for a directory in the profile's
  agent workspace `connectors/<id>/` (the directory name must be the manifest `id`); an installed
  connector of that id is replaced (like `--replace`: an approved one waits for approval again). It
  returns the id, status, hash prefix, module, kind, hosts and secret ids, and runs nothing. The read
  tool `connectors()` lists the installed connectors with their status, the last run's outcome, error
  kind and time, and the profile's binding count (never messages, stderr, params or secrets).
- Other commands: `cashu connectors list`, `show <id>` (manifest facts, files with sha, status, diff
  since the approval), `disable <id>` (stops it; bindings and secrets stay), `remove <id>` (deletes the
  files, bindings, their secrets and the run log).

There is no `approve` in the CLI or in MCP.

## 8. Approval (the owner, in the app)

The owner opens **Ustawienia > Konektory**, clicks the connector and sees, before anything runs:

- what is approved: the `run` command and the resolved interpreter path, the timeout, the network (none,
  or the exact hosts), the secrets and params by label, the extensions or the fetch history depth, the
  content hash, and that the connector can write only its temporary run directory;
- the details: id, version, author, description, module, kind, how it was installed (CLI or agent);
- every file with its size and sha256, and a code viewer for text files (<= 200 KiB);
- the run history (outcome, records, refused hosts, the redacted stderr tail).

`Zatwierdź` pins the hash and the interpreter path the owner looked at; when the files changed in the
meantime the approval is refused and the owner must look again. A later change of any file or of the
interpreter's resolved path turns the connector `changed`: it does not run, and the owner sees which
files were added, removed or modified, and a line diff of each text file against the copy the app kept
at the last approval, before approving again. Statuses: `pending` (do zatwierdzenia),
`approved` (zatwierdzony), `changed` (zmieniony), `disabled` (wyłączony). A `disabled` connector stays
`disabled` when its files or interpreter change, but the app shows the same "what changed" view
(`content_changed`), and enabling it again is an approval of the current content.

## 9. Bindings, imports and sync

**File connectors** appear in the import drawers of their module (Wydatki > Import, Inwestycje > Import)
for files with a matching extension, next to the built-in importers. With `rozpoznaj automatycznie` the
built-in importers go first (the cashU formats, a bank signature or a CSV mapping); only when none
recognises the file does the app run `detect` on at most 5 approved connectors of the module reading that
extension (the account's remembered connector first, 10 s each) and pick the highest confidence of at
least 0.5. The chosen connector runs `convert` once; the converted document is what the preview shows and
what the commit writes (the commit does not run the connector again), and the owner commits. The choice is
remembered per account in both modules (investments: the account's importer setting; budget: the importer
of the account's last import), and `rozpoznaj automatycznie` asks that connector first.

**Fetch connectors** need a **binding**: connector x profile x account, with the params, the secrets and
the cursor. The owner creates it in the connector's view in Ustawienia > Konektory (`Powiązania`) and
can test it there (`Sprawdź połączenie` runs `check`; a check is not a sync and never delays the next
one). A sync runs `fetch`: on demand from the binding's
`Synchronizuj`, and for every due binding from the module's sync action (Wydatki `Synchronizuj`, the
investments run) and the background worker. Due = approved connector, every secret set, at most once per
20 h per binding, 48 h pause after `rate_limited`, no proposal of the binding waiting for the owner; one
failing binding never stops the others; two syncs of one binding never run at once. The worker syncs the
bindings before the investments daily check, so what they commit is in that day's check.

- **The first sync of a binding always becomes a proposal** the owner reviews and commits.
- Later syncs are committed automatically only when the owner switched on `Automatyczny zapis`, the
  binding already had an owner-approved commit, and the preview is clean: no blocking problem, no
  warning, only new records (already imported ones are skipped by deduplication; no new instruments,
  renames, delistings or reconciliation differences). Otherwise the result waits as a proposal. A sync
  with blocking problems stores nothing; one with nothing new stores nothing either.
- **At most one proposal per binding.** While a sync proposal of the binding waits for the owner, a sync
  runs nothing and answers with that proposal (`pending_exists`); the worker skips the binding and sends no
  new notification. Approve or reject it first.
- **Budget:** a document is deduplicated against the account's stored transactions with the newest-day
  rule ([`budget-import-format.md`](budget-import-format.md) section 4): rows the bank CSV or Open
  Banking already covers are skipped and reported as overlap (never auto-committed). A document whose
  `account.currency` differs from the bound account's currency is a blocking problem.
- **Cursor:** the `cursor` you return is saved only when its import is committed (automatically or by
  the owner approving the proposal), or, after the first commit, when a sync brings nothing new. A
  rejected or pending proposal leaves the old cursor, so the next fetch starts from it again; your output
  must tolerate that (stable ids, section 5). Approving a proposal after the binding synced again is
  refused (`cursor_conflict`): the owner syncs again instead.

## 10. Secrets and privacy

- **Secrets** are entered by the owner only: in the binding form in the app (a password field) or with
  `cashu connectors secret set <binding> <secret_id>` (hidden prompt). They live in the macOS keychain,
  are never returned by any endpoint, never stored in runs, logs, proposals or MCP answers, and reach
  your process only on stdin, for `fetch` and `check`. Never print, log or echo them; never put them in
  a URL query, the cursor or the document. (The app also replaces secret values in your message and
  stderr, as a safety net.) An agent that writes a fetch connector never asks the user for a key.
- **Messages are value-free.** Name the row and the field and what is wrong (`row 7: column Kwota: not
  a number`), never the value, the account number, a name or an amount. The owner sees your message and
  stderr tail; an agent sees only the error kind and counts. `connectors test` prints a failed run's
  message with quoted text, account numbers (also with a country prefix), e-mails, capitalised names and
  numbers (except row / line / column numbers) replaced, but do not rely on it: a lower-case name, for
  one, passes.
- Read only the input file and your own directory; write only the run directory; send data only to the
  manifest's hosts. A connector that needs more is not a connector.

## 11. Checklist

1. `connector.yaml` passes `cashu connectors test <dir> --check-manifest`.
2. Only stdlib or files inside the directory (no `pip install` at run time: there is no network).
3. One JSON object on stdout, logs on stderr, exit 0 or 1 with an error object.
4. `detect` answers `false` for foreign files instead of failing.
5. Stable ids, deterministic output, exact decimals, outflows negative.
6. Value-free messages and logs; secrets never printed.
7. Fetch: `HTTPS_PROXY` honoured, `check` implemented, `params.fixture` path for the offline test, cursor
   tolerant to a repeated fetch.
8. `cashu connectors test` reports OK on a synthetic sample (and, with the user's consent, on the real
   export); then install it and tell the owner to approve it in Ustawienia > Konektory.
