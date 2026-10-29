// Texts of core/messages.ts that have no English server text to fall back on. See src/i18n.ts.
import { catalog } from "../i18n.ts";

export const S = catalog({
  /** A request that never reached the server (no response). */
  offline: { pl: "Brak połączenia z aplikacją (serwer cashU nie odpowiada)", en: "Can't reach the app (the cashU server is not responding)" },
});

/** English labels of the codes the UI shows without a server text of its own: frontend-only codes
 * (`import.preview_expired`, a client-side size check), the moved-app parts and connector failure
 * kinds (shown from a bare `kind`). Every other code falls back to the server's English text. */
export const EN_LABELS: Record<string, string | ((p: Record<string, unknown>) => string | null)> = {
  "import.preview_expired": "The preview expired: choose the file again.",
  "error.file_too_large": "The file is too large.",
  "error.loan_name_taken": "A loan with this name already exists.",
  "relocation.missing": "Background work points to a program that no longer exists",
  "relocation.other_program": "Background work points to another copy of the app",
  "relocation.moved": "The app was moved from {path}",
  "relocation.mcp_readd": "Add the MCP server in Claude Code again (the command is in AI agent).",
  "connector.bad_file": "The connector did not recognize this file.",
  "connector.unsupported_version": "The connector does not support this export version.",
  "connector.auth_failed": "The service rejected the key: check the binding's secret.",
  "connector.rate_limited": "The service limited the number of requests; it will try again later.",
  "connector.network": "Can't connect to the service.",
  "connector.upstream": "The service responded with an error.",
  "connector.internal": "Error in the connector.",
  "connector.protocol": "The connector's response does not follow the protocol.",
  "connector.timeout": (p) => (p.timeout_s != null ? `The connector timed out (${p.timeout_s} s).` : "The connector timed out."),
  "connector.sandbox_unavailable": "Connectors run only in the macOS app (no sandbox).",
  "connector.spawn_failed": "Could not start the connector.",
  "connector.not_approved": "The connector is waiting for approval in Settings › Connectors.",
  "connector.changed": "The connector changed: approve it again in Settings › Connectors.",
  "connector.interpreter_changed": "The connector's interpreter changed: approve it again in Settings › Connectors.",
  "connector.disabled": "The connector is disabled.",
  "connector.missing": "The connector's folder is gone from the disk.",
  "connector.bad_request": "The connector will not accept this file (extension or size).",
  "connector.denied_host": "The connector tried to connect outside the allowed hosts.",
};
