"""MCP tool providers: thin adapters over the services of core and each module. Each module file exports
``TOOLS: tuple[ToolSpec, ...]``; handlers return labelled trees (``core.mcp.labels``)."""
