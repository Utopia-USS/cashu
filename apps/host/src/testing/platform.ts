// Platform gates for tests whose subject only runs on some operating systems (tests only).

/**
 * Connectors run on macOS only (catalog.ts, main.ts gate): the connector catalog takes POSIX data
 * dirs and owner-only modes, so a test that builds a `ConnectorCatalog` skips on Windows.
 */
export const connectorsUnsupported = process.platform === "win32";
