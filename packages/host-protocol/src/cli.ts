// The `cli.*` methods (role `cli`): how the `cashu` shim runs a command in the host (S56d). This is the
// shim's frozen surface: the command tree, parsing, formatting and i18n live in the host, so a new
// command never needs a new shim.
//
//   shim -> host  req  cli.exec {argv, cwd, env, tty, paths}
//   host -> shim  note cli.out {stream, data}          (id = the exec request: output, in order)
//   host -> shim  note cli.prompt {pid, text, hidden}   (ask the terminal; the shim answers cli.answer)
//   shim -> host  req  cli.answer {exec, pid, value}    (value null: end of input or no terminal)
//   host -> shim  note cli.stdin {}                     (start sending standard input)
//   shim -> host  req  cli.stdin {exec, data, eof}      (base64 chunks; the reply is the flow control)
//   shim -> host  cancel {id: exec}                     (Ctrl-C: the command is asked to stop)
//   host -> shim  res  cli.exec {kind: "exit", code}
import { z } from "zod";

/** Environment variables the shim forwards to a command run in the host (never the whole env). */
export const CLI_ENV_KEYS =
  /^(CASHU_[A-Z0-9_]+|FINANSE_[A-Z0-9_]+|NO_COLOR|FORCE_COLOR|TERM|LANG|LC_ALL|LC_MESSAGES|COLUMNS)$/;

const text = (max: number) => z.string().max(max);
const argSchema = text(64 * 1024);

export const cliExecParamsSchema = z.object({
  /** The arguments after the program name, as typed. */
  argv: z.array(argSchema).max(4_096),
  /** The shim's working directory (absolute): relative file arguments resolve against it. */
  cwd: text(4_096).refine((p) => p.startsWith("/"), "cwd must be absolute"),
  /** Caller path expansion context, never installed into the host's environment. */
  paths: z.object({
    // `~` expands to HOME verbatim, including empty/relative values.
    home: text(4_096).refine((p) => !p.includes("\u0000"), "home contains NUL"),
  }),
  /** Only `CLI_ENV_KEYS`. */
  env: z
    .record(z.string(), text(64 * 1024))
    .refine((env) => Object.keys(env).every((k) => CLI_ENV_KEYS.test(k)), "env key not forwarded"),
  tty: z.object({
    stdin: z.boolean(),
    stdout: z.boolean(),
    stderr: z.boolean(),
    columns: z.number().int().positive().max(10_000).optional(),
    rows: z.number().int().positive().max(10_000).optional(),
    /** Rich's explicit terminal override, independent of the fd's TTY bit. */
    compatible: z.boolean().optional(),
  }),
});
export type CliExecParams = z.infer<typeof cliExecParamsSchema>;

export const cliExecResultSchema = z.object({
  kind: z.literal("exit"),
  code: z.number().int().min(0).max(255),
});
export type CliExecResult = z.infer<typeof cliExecResultSchema>;

export const cliOutNoteSchema = z.object({
  stream: z.enum(["stdout", "stderr"]),
  data: text(4 * 1024 * 1024),
});
export type CliOutNote = z.infer<typeof cliOutNoteSchema>;

const promptId = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const cliPromptNoteSchema = z.object({
  pid: promptId,
  /** Shown before the input (no newline added). */
  text: text(4_096),
  /** Read without echo (a secret). */
  hidden: z.boolean(),
});
export type CliPromptNote = z.infer<typeof cliPromptNoteSchema>;

export const cliStdinNoteSchema = z.object({});

const execId = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const cliAnswerParamsSchema = z.object({
  exec: execId,
  pid: promptId,
  /** The line without its newline; null when the input ended or no terminal can answer. */
  value: text(64 * 1024).nullable(),
});
export type CliAnswerParams = z.infer<typeof cliAnswerParamsSchema>;

/** Largest stdin chunk the shim sends (decoded bytes). */
export const CLI_STDIN_CHUNK = 256 * 1024;

export const cliStdinParamsSchema = z.object({
  exec: execId,
  /** Base64 of at most `CLI_STDIN_CHUNK` bytes. */
  data: z
    .string()
    .max(Math.ceil(CLI_STDIN_CHUNK / 3) * 4)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/),
  eof: z.boolean(),
});
export type CliStdinParams = z.infer<typeof cliStdinParamsSchema>;

/** Exit code of a command stopped by Ctrl-C (128 + SIGINT), as a shell reports it. */
export const CLI_INTERRUPTED_EXIT = 130;
