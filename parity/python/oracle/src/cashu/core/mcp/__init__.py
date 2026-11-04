"""MCP server for agents (``cashu mcp --profile <slug>``): one profile per server, every field of
every response labelled and redacted by the profile's privacy level, every call audited.

- ``labels``: sensitivity labels and the labelled values tool handlers return;
- ``redaction``: the privacy layer (labels -> what may be sent; text scrubbing; leak check);
- ``names``: person names the redaction must never send (profile, accounts, private payees);
- ``registry``: tool specs collected from core and the enabled modules (``tools/``);
- ``audit``: the ``mcp_calls`` log (argument names and types, never values);
- ``server``: the profile-bound tool host and the stdio transport (official ``mcp`` SDK).
"""
