// `cli.exec` from the shim's side: send the argv, cwd, forwarded env and terminal facts; write the
// host's output notes to our stdout / stderr in order; answer prompts from the terminal (hidden ones
// without echo); stream stdin when the host asks; Ctrl-C asks the host to cancel (a second Ctrl-C
// leaves at once). The reply is an exit code, or `delegate` for a command not ported yet.
//
// Standard input is never read before the host asks for it: a delegated command inherits fd 0, and
// bytes the shim had buffered would be lost to it. For the same reason a `delegate` reply after the
// shim touched stdin or printed output is refused as a protocol error.
import { isatty } from "node:tty";
import {
  CLI_ENV_KEYS,
  CLI_INTERRUPTED_EXIT,
  CLI_STDIN_CHUNK,
  type CliExecParams,
  type CliExecResult,
  cliExecResultSchema,
  cliOutNoteSchema,
  cliPromptNoteSchema,
  type HostFrame,
} from "@cashu/host-protocol";
import type { HostConnection } from "@cashu/node-host";
import { type Terminal, TerminalInput } from "./terminal.js";

/** The connection ended before the host answered (the host stopped or crashed). */
export class HostLostError extends Error {
  constructor() {
    super("the host connection closed during the command");
    this.name = "HostLostError";
  }
}

/** The host broke the shim's protocol (a bug, refused loudly). */
export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

/** The environment variables forwarded to a command run in the host. */
export function forwardedEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && CLI_ENV_KEYS.test(key)) out[key] = value;
  }
  return out;
}

export interface ExecOptions {
  readonly argv: readonly string[];
  readonly cwd: string;
  /** Already merged with what `.env.dev` adds. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly terminal: Terminal;
  /** Installs the Ctrl-C handler for the duration of the command; returns its removal. */
  readonly onInterrupt: (handler: () => void) => () => void;
}

function execParams(options: ExecOptions): CliExecParams {
  // A terminal that reports no size (0, e.g. a fresh pty) sends none.
  const columns = options.terminal.columns() || undefined;
  const rows = options.terminal.rows() || undefined;
  return {
    argv: [...options.argv],
    cwd: options.cwd,
    env: forwardedEnv(options.env),
    tty: {
      stdin: isatty(0),
      stdout: isatty(1),
      stderr: isatty(2),
      ...(columns === undefined ? {} : { columns }),
      ...(rows === undefined ? {} : { rows }),
    },
  };
}

/** Runs one `cli.exec` on `conn`; resolves with the host's reply (exit or delegate). */
export function runExec(conn: HostConnection, options: ExecOptions): Promise<CliExecResult> {
  const EXEC = 1;
  let nextId = 2;
  const input = new TerminalInput(options.terminal);
  let touched = false;
  let interrupts = 0;
  return new Promise<CliExecResult>((resolve, reject) => {
    let done = false;
    const pending = new Map<number, () => void>();
    const request = (method: string, params: unknown): Promise<void> => {
      const id = nextId++;
      return new Promise((ok) => {
        pending.set(id, ok);
        conn.send({ t: "req", id, method, params: params as never });
      });
    };
    const finish = (outcome: () => void) => {
      if (done) return;
      done = true;
      removeInterrupt();
      input.close();
      outcome();
    };
    const removeInterrupt = options.onInterrupt(() => {
      interrupts += 1;
      if (interrupts === 1) conn.send({ t: "cancel", id: EXEC });
      else finish(() => resolve({ kind: "exit", code: CLI_INTERRUPTED_EXIT }));
    });

    const streamStdin = async () => {
      touched = true;
      for await (const chunk of input.stdinChunks(CLI_STDIN_CHUNK)) {
        if (done) return;
        await request("cli.stdin", {
          exec: EXEC,
          data: Buffer.from(chunk).toString("base64"),
          eof: false,
        });
      }
      if (!done) await request("cli.stdin", { exec: EXEC, data: "", eof: true });
    };

    const onFrame = (frame: HostFrame) => {
      if (frame.t === "res") {
        if (frame.id !== EXEC) {
          pending.get(frame.id)?.();
          pending.delete(frame.id);
          return;
        }
        if (!frame.outcome.ok) {
          const error = frame.outcome.error;
          return finish(() => reject(new ProtocolError(`${error.code}: ${error.message}`)));
        }
        const result = cliExecResultSchema.safeParse(frame.outcome.result);
        if (!result.success)
          return finish(() => reject(new ProtocolError("invalid cli.exec reply")));
        if (result.data.kind === "delegate" && touched) {
          return finish(() => reject(new ProtocolError("delegate after output or input")));
        }
        return finish(() => resolve(result.data));
      }
      if (frame.t !== "note" || frame.id !== EXEC) return;
      switch (frame.method) {
        case "cli.out": {
          const note = cliOutNoteSchema.safeParse(frame.params);
          if (!note.success) return;
          touched = true;
          options.terminal.write(note.data.stream, note.data.data);
          return;
        }
        case "cli.prompt": {
          const note = cliPromptNoteSchema.safeParse(frame.params);
          if (!note.success) return;
          touched = true;
          const { pid, text, hidden } = note.data;
          void input.prompt(text, hidden).then((answer) => {
            if (answer === "interrupt") {
              interrupts += 1;
              conn.send({ t: "cancel", id: EXEC });
              return request("cli.answer", { exec: EXEC, pid, value: null });
            }
            return request("cli.answer", { exec: EXEC, pid, value: answer });
          });
          return;
        }
        case "cli.stdin":
          void streamStdin();
          return;
      }
    };
    conn.onFrame(onFrame);
    conn.onClose(() => finish(() => reject(new HostLostError())));
    conn.send({ t: "req", id: EXEC, method: "cli.exec", params: execParams(options) as never });
  });
}
