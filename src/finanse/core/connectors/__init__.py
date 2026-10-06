"""Connectors: third-party code the owner approved, run out of process in a sandbox (F10).

A connector is a directory with ``connector.yaml`` plus code in any language. It converts an export file
(``kind: file``) or pulls data from an API (``kind: fetch``) into a documented import format; its output
always goes through the normal validation and preview. The app runs a connector only when the owner
approved it in the app (pinned by content hash and interpreter path), out of process, in a sandbox, with a
timeout. Nothing here is reachable from MCP as a way to run code.

- ``manifest``: manifest model and validation, directory rules, content hash, interpreter resolution;
- ``protocol``: the stdin / stdout JSON protocol;
- ``process`` / ``sandbox`` / ``proxy``: process control, the ``ConnectorSandbox`` seam, the egress proxy;
- ``runner``: one run (run dir, input copy, environment, proxy, sandbox, response);
- ``service``: install, registry, approval, bindings, recorded runs; ``api`` / ``cli`` on top.
"""
