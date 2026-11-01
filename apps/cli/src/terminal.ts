// The shim's terminal: output writes, the window size, and standard input read only on demand
// (prompt answers, hidden input without echo, or the whole stream when a host command asks for it).
// `Terminal` is the process; tests pass a fake.
import { closeSync, openSync } from "node:fs";
import { isatty, WriteStream } from "node:tty";

export interface Terminal {
  write(stream: "stdout" | "stderr", data: string): void;
  columns(): number | undefined;
  rows(): number | undefined;
  readonly stdin: NodeJS.ReadableStream & {
    readonly isTTY?: boolean;
    setRawMode?(mode: boolean): unknown;
  };
}

export function processTerminal(): Terminal {
  return {
    write: (stream, data) => {
      (stream === "stdout" ? process.stdout : process.stderr).write(data);
    },
    columns: () => terminalSize()?.[0],
    rows: () => terminalSize()?.[1],
    get stdin() {
      return process.stdin;
    },
  };
}

/** Rich probes stdin, stdout and stderr on POSIX, including when stdout is redirected. */
export function terminalSize(): readonly [number, number] | undefined {
  if (process.platform !== "win32" && isatty(0)) {
    let fd: number | undefined;
    let stream: WriteStream | undefined;
    try {
      // A separate descriptor ensures destroying the sizing stream never closes caller stdin.
      fd = openSync("/dev/fd/0", "w");
      stream = new WriteStream(fd);
      return stream.getWindowSize();
    } catch {
      /* Fall back to the output descriptors if stdin cannot be reopened. */
    } finally {
      if (stream !== undefined) stream.destroy();
      else if (fd !== undefined) closeSync(fd);
    }
  }
  if (isatty(1)) return process.stdout.getWindowSize();
  if (isatty(2)) return process.stderr.getWindowSize();
  return undefined;
}

const NEWLINE = 0x0a;
const CR = 0x0d;
const CTRL_C = 0x03;
const CTRL_D = 0x04;
const BACKSPACE = 0x7f;
const CTRL_H = 0x08;

/** Reads standard input lazily; attaches to it on the first use only. */
export class TerminalInput {
  private readonly terminal: Terminal;
  private buffer = Buffer.alloc(0);
  private ended = false;
  private attached = false;
  private wake: (() => void) | undefined;

  constructor(terminal: Terminal) {
    this.terminal = terminal;
  }

  private attach(): void {
    if (this.attached) return;
    this.attached = true;
    const stdin = this.terminal.stdin;
    stdin.on("data", (chunk: Buffer | string) => {
      this.buffer = Buffer.concat([
        this.buffer,
        typeof chunk === "string" ? Buffer.from(chunk) : chunk,
      ]);
      this.notify();
    });
    stdin.on("end", () => {
      this.ended = true;
      this.notify();
    });
    stdin.on("error", () => {
      this.ended = true;
      this.notify();
    });
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }

  private more(): Promise<void> {
    return new Promise((resolve) => {
      this.wake = resolve;
      this.terminal.stdin.resume();
    });
  }

  /** One line without its newline; null at the end of input. */
  private async line(): Promise<string | null> {
    this.attach();
    for (;;) {
      const at = this.buffer.indexOf(NEWLINE);
      if (at !== -1) {
        const line = this.buffer.subarray(0, at);
        this.buffer = this.buffer.subarray(at + 1);
        this.terminal.stdin.pause();
        return line.toString("utf8").replace(/\r$/, "");
      }
      if (this.ended) {
        if (this.buffer.length === 0) return null;
        const rest = this.buffer.toString("utf8");
        this.buffer = Buffer.alloc(0);
        return rest;
      }
      await this.more();
    }
  }

  /** Typed characters without echo (raw mode): Enter ends, Ctrl-C interrupts, Ctrl-D on empty ends. */
  private async hiddenLine(): Promise<string | null | "interrupt"> {
    this.attach();
    const stdin = this.terminal.stdin;
    stdin.setRawMode?.(true);
    const typed: number[] = [];
    try {
      for (;;) {
        while (this.buffer.length > 0) {
          const byte = this.buffer[0] as number;
          this.buffer = this.buffer.subarray(1);
          if (byte === CR || byte === NEWLINE) return Buffer.from(typed).toString("utf8");
          if (byte === CTRL_C) return "interrupt";
          if (byte === CTRL_D) {
            if (typed.length === 0) return null;
            continue;
          }
          if (byte === BACKSPACE || byte === CTRL_H) {
            // Drop one UTF-8 character (its continuation bytes too).
            while (typed.length > 0 && ((typed.pop() as number) & 0xc0) === 0x80) {}
            continue;
          }
          typed.push(byte);
        }
        if (this.ended) return typed.length === 0 ? null : Buffer.from(typed).toString("utf8");
        await this.more();
      }
    } finally {
      stdin.setRawMode?.(false);
      stdin.pause();
      this.terminal.write("stderr", "\n");
    }
  }

  /** Shows `text` on stderr and reads the answer (hidden: no echo, when stdin is a terminal). */
  prompt(text: string, hidden: boolean): Promise<string | null | "interrupt"> {
    this.terminal.write("stderr", text);
    return hidden && this.terminal.stdin.isTTY === true ? this.hiddenLine() : this.line();
  }

  /** The rest of standard input, in chunks of at most `max` bytes. */
  async *stdinChunks(max: number): AsyncGenerator<Uint8Array> {
    this.attach();
    for (;;) {
      while (this.buffer.length > 0) {
        const chunk = this.buffer.subarray(0, max);
        this.buffer = this.buffer.subarray(chunk.length);
        yield chunk;
      }
      if (this.ended) return;
      await this.more();
    }
  }

  /** Lets the process exit: stops reading standard input if it was used. */
  close(): void {
    if (!this.attached) return;
    this.terminal.stdin.pause();
    this.notify();
  }
}
