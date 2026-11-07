/// <reference types="node" />
// Electron main's side of the `migrate --data-dir <dir> --json` child ("Import my data" on the
// recovery screen). The protocol is in @cashu/host-protocol/startup-failure (migrateProtocol.ts):
// NDJSON progress lines, one `recovery-words` line the parent answers on stdin with `confirm` or
// `cancel`, and a final `done` (exit 0) or `failed` (exit 1) line. Every line is parsed strictly; any
// other line, a second final line, a crash or another exit is an `unknown` failure. The words go only
// to `handlers.words` and are never stored or logged here.
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { reconnectMcpCommands } from "@cashu/domain/core";
import {
  MIGRATE_CANCEL,
  MIGRATE_CONFIRM,
  type MigrateDone,
  type MigrateFailed,
  type MigrateStage,
  parseMigrateLine,
  type RecoveryImportEvent,
  recoveryImportEventSchema,
  type StartupFailure,
  startupFailure,
} from "@cashu/host-protocol/startup-failure";

/** The part of a spawned `ChildProcess` the parent uses (a fake in tests). */
export interface MigrateChild {
  readonly stdout: Readable | null;
  readonly stdin: Writable | null;
  once(event: "close", listener: (code: number | null) => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
}

export interface MigrateHandlers {
  progress(stage: MigrateStage): void;
  /**
   * Shows the new recovery words once; resolves true when the user confirmed they are written down,
   * false when they cancelled.
   */
  words(words: string): Promise<boolean>;
}

export type MigrateOutcome =
  | { readonly kind: "done"; readonly done: MigrateDone }
  | { readonly kind: "failed"; readonly failure: StartupFailure }
  | { readonly kind: "cancelled" };

const UNKNOWN: MigrateOutcome = { kind: "failed", failure: startupFailure("unknown") };

export function runMigration(
  child: MigrateChild,
  handlers: MigrateHandlers,
): Promise<MigrateOutcome> {
  return new Promise<MigrateOutcome>((resolve) => {
    let final: MigrateDone | MigrateFailed | null = null;
    let broken = false;
    let asked = false;
    let cancelled = false;
    let settled = false;
    const settle = (outcome: MigrateOutcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    const stdin = child.stdin;
    // A child that exited early closes the pipe; a write then fails with EPIPE, which is no news.
    stdin?.on("error", () => {});
    const answer = (text: string, end: boolean) => {
      if (stdin === null || stdin.destroyed || stdin.writableEnded) return;
      if (end) stdin.end(text);
      else stdin.write(text);
    };
    const breakProtocol = () => {
      broken = true;
      // A child waiting for an answer sees end of input and aborts (nothing is created).
      answer("", true);
    };

    child.once("error", () => settle(UNKNOWN));
    child.once("close", (code) => {
      if (broken) settle(cancelled ? { kind: "cancelled" } : UNKNOWN);
      else if (final?.event === "done" && code === 0) settle({ kind: "done", done: final });
      else if (cancelled) settle({ kind: "cancelled" });
      else if (final?.event === "failed" && code === 1)
        settle({ kind: "failed", failure: startupFailure(final.code, final.detail) });
      else settle(UNKNOWN);
    });

    if (child.stdout === null) {
      breakProtocol();
      return;
    }
    const lines = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
    lines.on("line", (raw) => {
      if (broken) return;
      const line = parseMigrateLine(raw);
      if (line === null || final !== null) {
        breakProtocol();
        return;
      }
      switch (line.event) {
        case "progress":
          handlers.progress(line.stage);
          return;
        case "recovery-words":
          if (asked) {
            breakProtocol();
            return;
          }
          asked = true;
          void handlers.words(line.words).then(
            (confirmed) => {
              if (confirmed && !broken) answer(MIGRATE_CONFIRM, false);
              else {
                cancelled = true;
                answer(MIGRATE_CANCEL, true);
              }
            },
            () => {
              cancelled = true;
              answer(MIGRATE_CANCEL, true);
            },
          );
          return;
        case "done":
        case "failed":
          final = line;
          return;
      }
    });
  });
}

/**
 * What the recovery screen shows after a finished import, or null when there is nothing to say (the
 * app then opens at once): the instruments the app cannot value, the `claude mcp remove` / `add` lines
 * per imported profile (the setup screen's builder over the data dir's stable launcher `launcher` and
 * the app flavor's MCP server prefix),
 * and what became of the Python worker agents. Checked against the event schema before it leaves.
 */
export function importDoneEvent(
  done: MigrateDone,
  launcher: string,
  mcpServerPrefix: string,
): Extract<RecoveryImportEvent, { kind: "done" }> | null {
  const unpriced = done.unpriced ?? [];
  const mcpCommands = reconnectMcpCommands([launcher], done.mcpProfiles ?? [], mcpServerPrefix);
  const agents = done.agents ?? null;
  if (unpriced.length === 0 && mcpCommands.length === 0 && agents === null) return null;
  const event = recoveryImportEventSchema.parse({ kind: "done", unpriced, mcpCommands, agents });
  return event.kind === "done" ? event : null;
}
