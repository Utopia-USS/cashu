// The one block for every connector failure (design/v3/connectors 5.4): the kind's Polish line, the
// connector's own message, the stderr tail behind `Szczegóły` (owner UI only; MCP never gets it).
import type { CSSProperties } from "react";
import { kindLine } from "./connectors";
import { ApiError } from "./api";
import { Notice } from "../ui";

export interface RunFailure { kind: string; message?: string | null; stderr?: string | null; timeoutS?: number | null; connector?: string | null }

export function RunError({ kind, message, stderr, timeoutS, connector, open, style }: RunFailure & { open?: boolean; style?: CSSProperties }) {
  return (
    <Notice tone="neg" style={style}>
      <div><b>{kindLine(kind, timeoutS)}</b>{connector ? <span className="fhint"> · {connector}</span> : null}</div>
      {message && <div style={{ fontSize: 12.5, marginTop: 2 }}>{message}</div>}
      {stderr && (
        <details className="more" open={open}>
          <summary>Szczegóły</summary>
          <pre className="diff" style={{ marginTop: 6 }}>{stderr}</pre>
        </details>
      )}
    </Notice>
  );
}

/** A connector failure inside an import preview (contract C5: a 422 whose `detail` is an object), else null. */
export function runFailureOf(e: unknown): RunFailure | null {
  if (!(e instanceof ApiError) || !e.body || typeof e.body !== "object") return null;
  const b = e.body as { kind?: unknown; message?: unknown; stderr_tail?: unknown; timeout_s?: unknown; connector?: unknown };
  if (typeof b.kind !== "string") return null;
  const c = b.connector as { name?: unknown; id?: unknown } | string | null | undefined;
  return {
    kind: b.kind,
    message: typeof b.message === "string" ? b.message : null,
    stderr: typeof b.stderr_tail === "string" ? b.stderr_tail : null,
    timeoutS: typeof b.timeout_s === "number" ? b.timeout_s : null,
    connector: typeof c === "string" ? c : c && typeof c.name === "string" ? c.name : null,
  };
}
