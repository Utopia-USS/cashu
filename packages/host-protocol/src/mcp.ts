// An `mcp` session (S56d): the shim of `cashu mcp --profile <slug>` first opens the session with
// `mcp.open {cwd, env}` (file paths in tool arguments resolve against the shim's cwd, as when the
// server ran in the shim's process), then forwards each line of its stdin (one MCP JSON-RPC message)
// as an `mcp` frame and writes each `mcp` frame from the host as a line on its stdout. The MCP server
// runs in the host, bound to the profile named at hello. Besides the lines:
//
//   shim -> host  req  mcp.eof {}           the client closed stdin: the server's input ends (it then
//                                          exits on its own and the shim exits with its code)
//   host -> shim  note mcp.stderr {data}   diagnostics the server wrote (the shim's stderr, as today)
//   host -> shim  note mcp.exit {code}     the server ended on its own (e.g. an unknown profile, or
//                                          the app was replaced): the shim exits with `code` and does
//                                          not reconnect. A session that closes without it means the
//                                          host went away: the shim reconnects, replays the client's
//                                          `initialize` and sends `notifications/tools/list_changed`.
import { z } from "zod";
import { CLI_ENV_KEYS } from "./cli.js";

export const mcpOpenParamsSchema = z.object({
  cwd: z
    .string()
    .max(4_096)
    .refine((p) => p.startsWith("/"), "cwd must be absolute"),
  /** Only `CLI_ENV_KEYS` (the variables an `.mcp.json` entry may set for the server). */
  env: z
    .record(z.string(), z.string().max(64 * 1024))
    .refine((env) => Object.keys(env).every((k) => CLI_ENV_KEYS.test(k)), "env key not forwarded"),
});
export type McpOpenParams = z.infer<typeof mcpOpenParamsSchema>;

export const mcpStderrNoteSchema = z.object({ data: z.string().max(1024 * 1024) });
export type McpStderrNote = z.infer<typeof mcpStderrNoteSchema>;

export const mcpExitNoteSchema = z.object({ code: z.number().int().min(0).max(255) });
export type McpExitNote = z.infer<typeof mcpExitNoteSchema>;
