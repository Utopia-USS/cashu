// Internal device-audit write shapes, shared without coupling commands to their store implementation.
export interface McpAuditStart {
  readonly vault: string;
  readonly tool: string;
  readonly calledAt: string;
  readonly args: Readonly<Record<string, string | number>>;
}
export interface McpAuditFinish {
  readonly id: number;
  readonly vault: string;
  readonly privacy: "strict" | "amounts";
  readonly outcome: "ok" | "error" | "refused";
  readonly errorKind: string | null;
  readonly durationMs: number;
}
