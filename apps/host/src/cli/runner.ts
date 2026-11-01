// The host side of a `cli` session (S56d): one `cli.exec` at a time. The argv goes through the hosted
// command tree; a ported command runs here with a `CommandIo` whose output, prompts and stdin travel
// as session frames; anything not ported is answered `delegate` with the Python CLI to run
// (TRANSITIONAL(S49)). Ctrl-C (`cancel`) aborts the command's signal. Unexpected errors end the
// command with exit 70 and the error's class name only (messages may quote data); logs carry codes.
import {
  CLI_INTERRUPTED_EXIT,
  type CliExecParams,
  type CliExecResult,
  cliAnswerParamsSchema,
  cliExecParamsSchema,
  cliStdinParamsSchema,
} from "@cashu/host-protocol";
import { createBackendI18n, createTranslator, type Translator } from "@cashu/i18n";
import { type HostSession, nodeLanguageSource } from "@cashu/node-host";
import { errorName, type HostLog } from "../log.js";
import type { Program } from "../runtime.js";
import { S } from "./strings.js";
import { type CommandIo, type PortedCommand, runTree } from "./tree.js";

const FAILURE_EXIT = 70;
const UNAVAILABLE_EXIT = 69;

export interface CliRunnerDeps {
  readonly dataDir: string;
  readonly ported: readonly PortedCommand[];
  readonly delegated: Readonly<Record<string, string>>;
  /** TRANSITIONAL(S49): the Python CLI, undefined when this build has none. */
  readonly python: Program | undefined;
  readonly log: HostLog;
}

/** The language of one command: its env (CASHU_LANG, locale), settings.json, the OS, English. */
function translatorFor(params: CliExecParams, dataDir: string): Translator {
  const source = nodeLanguageSource({ env: params.env, dataDir });
  return createTranslator(createBackendI18n(source).appLanguage());
}

/** A byte queue fed by `cli.stdin` chunks, read by the command as an async iterable. */
class StdinQueue {
  private readonly chunks: Uint8Array[] = [];
  private ended = false;
  private wake: (() => void) | undefined;

  push(data: Uint8Array, eof: boolean): void {
    if (data.length > 0) this.chunks.push(data);
    if (eof) this.ended = true;
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }

  async *read(): AsyncGenerator<Uint8Array> {
    for (;;) {
      const next = this.chunks.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }
}

interface RunningExec {
  readonly id: number;
  readonly abort: AbortController;
  readonly prompts: Map<number, (value: string | null) => void>;
  readonly stdin: StdinQueue;
}

export function serveCliSession(session: HostSession, deps: CliRunnerDeps): void {
  let running: RunningExec | undefined;
  let nextPrompt = 1;

  const reply = (id: number, result: unknown) =>
    session.send({ t: "res", id, outcome: { ok: true, result: result as never } });
  const fail = (id: number, code: string, message: string) =>
    session.send({ t: "res", id, outcome: { ok: false, error: { code, message } } });
  const note = (id: number, method: string, params: unknown) =>
    session.send({ t: "note", id, method, params: params as never });

  const exec = async (id: number, params: CliExecParams): Promise<CliExecResult> => {
    const abort = new AbortController();
    const prompts = new Map<number, (value: string | null) => void>();
    const stdin = new StdinQueue();
    let stdinOpened = false;
    running = { id, abort, prompts, stdin };
    const t = translatorFor(params, deps.dataDir);
    const io: CommandIo = {
      cwd: params.cwd,
      env: params.env,
      tty: params.tty,
      signal: abort.signal,
      t,
      stdout: (data) => note(id, "cli.out", { stream: "stdout", data }),
      stderr: (data) => note(id, "cli.out", { stream: "stderr", data }),
      prompt(text, options) {
        const pid = nextPrompt++;
        return new Promise((resolve) => {
          prompts.set(pid, resolve);
          note(id, "cli.prompt", { pid, text, hidden: options?.hidden === true });
        });
      },
      stdin() {
        if (!stdinOpened) {
          stdinOpened = true;
          note(id, "cli.stdin", {});
        }
        return stdin.read();
      },
    };
    const outcome = await runTree(params.argv, io, deps.ported, deps.delegated);
    if (outcome.kind === "exit") {
      return { kind: "exit", code: abort.signal.aborted ? CLI_INTERRUPTED_EXIT : outcome.code };
    }
    if (deps.python === undefined) {
      io.stderr(`${t.tr(S.pythonMissing)}\n`);
      return { kind: "exit", code: UNAVAILABLE_EXIT };
    }
    return { kind: "delegate", command: deps.python.command, args: [...deps.python.args] };
  };

  session.onFrame((frame) => {
    if (frame.t === "cancel") {
      if (running?.id === frame.id) running.abort.abort();
      return;
    }
    if (frame.t !== "req") return session.close();
    switch (frame.method) {
      case "cli.exec": {
        const params = cliExecParamsSchema.safeParse(frame.params);
        if (!params.success) return fail(frame.id, "invalid-params", frame.method);
        if (running !== undefined) {
          return fail(frame.id, "busy", translatorFor(params.data, deps.dataDir).tr(S.busy));
        }
        exec(frame.id, params.data).then(
          (result) => {
            deps.log.info("cli.exec", {
              kind: result.kind,
              ...(result.kind === "exit" ? { code: result.code } : {}),
            });
            running = undefined;
            reply(frame.id, result);
          },
          (error: unknown) => {
            deps.log.error("cli.exec-failed", { error: errorName(error) });
            running = undefined;
            note(frame.id, "cli.out", {
              stream: "stderr",
              data: `cashu: unexpected ${errorName(error)}\n`,
            });
            reply(frame.id, { kind: "exit", code: FAILURE_EXIT });
          },
        );
        return;
      }
      case "cli.answer": {
        const params = cliAnswerParamsSchema.safeParse(frame.params);
        const waiter =
          params.success && running?.id === params.data.exec
            ? running.prompts.get(params.data.pid)
            : undefined;
        if (!params.success || waiter === undefined)
          return fail(frame.id, "invalid-params", frame.method);
        running?.prompts.delete(params.data.pid);
        reply(frame.id, {});
        waiter(params.data.value);
        return;
      }
      case "cli.stdin": {
        const params = cliStdinParamsSchema.safeParse(frame.params);
        if (!params.success || running?.id !== params.data.exec) {
          return fail(frame.id, "invalid-params", frame.method);
        }
        running.stdin.push(Buffer.from(params.data.data, "base64"), params.data.eof);
        reply(frame.id, {});
        return;
      }
      default:
        return fail(frame.id, "unknown-method", frame.method);
    }
  });
  session.onClose(() => {
    // The shim went away (killed, or its terminal closed): stop the command, end its prompts.
    if (running === undefined) return;
    running.abort.abort();
    for (const resolve of running.prompts.values()) resolve(null);
    running.stdin.push(new Uint8Array(), true);
  });
}
