import { spawn } from "node:child_process";
import {
  chmodSync,
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { Decimal, type JsonValue, parseJson } from "@cashu/domain";
import { z } from "zod";
import type { ConnectorCatalog } from "./catalog.js";
import { ConnectorFault, inside, type LoadedConnector, scanConnector } from "./manifest.js";
import { ConnectorEgressProxy } from "./proxy.js";

export const MAX_INPUT = 64 * 1024 * 1024;
const MAX_STDOUT = 64 * 1024 * 1024;
const MAX_STDERR = 64 * 1024;
const detectResponse = z.strictObject({
  match: z.boolean(),
  confidence: z.number().finite().min(0).max(1).default(1),
});
const documentResponse = z.strictObject({
  document: z.record(z.string(), z.unknown()),
  cursor: z.string().max(4096).nullable().optional(),
});
const checkResponse = z.strictObject({ ok: z.literal(true) });
const errorResponse = z.strictObject({
  error: z.strictObject({
    kind: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
    message: z.string().default(""),
  }),
});
export type ConnectorCommand = "detect" | "convert" | "fetch" | "check";
export type RunResult =
  | { readonly outcome: "ok"; readonly response: unknown; readonly documentBytes?: Uint8Array }
  | { readonly outcome: "refused" | "failed" | "timeout"; readonly errorKind: string };
interface FileInput {
  readonly path: string;
  readonly name: string;
}
export interface RunOptions {
  readonly catalog: ConnectorCatalog;
  readonly id: string;
  readonly interpreter: string;
  readonly command: ConnectorCommand;
  readonly file?: FileInput;
  readonly params?: Record<string, unknown>;
  readonly account?: { readonly currency: string; readonly label: string };
  readonly secrets?: Readonly<Record<string, string>>;
  readonly since?: string | null;
  readonly cursor?: string | null;
}

function sbpl(value: string): string {
  if ([...value].some((char) => char.charCodeAt(0) < 32))
    throw new ConnectorFault("invalid_directory", "unsafe sandbox path");
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function ancestors(path: string): string[] {
  const out: string[] = [];
  let current = resolve(path);
  while (current !== "/") {
    out.push(current);
    current = resolve(current, "..");
  }
  return out;
}

/** Deny-default kernel profile; no file outside the run/code/system roots, no network. */
export function macProfile(
  code: string,
  interpreter: string,
  runDir: string,
  proxyPort?: number,
): string {
  const source = realpathSync.native(code);
  const program = realpathSync.native(interpreter);
  const run = realpathSync.native(runDir);
  const prefix = resolve(program, "..", "..");
  const extra =
    !inside(source, program) &&
    !(program.includes(".app/Contents/") && basename(program) === "deno") &&
    !["/usr", "/bin", "/opt/homebrew", "/usr/local"].includes(prefix) &&
    !inside("/Users", prefix)
      ? prefix
      : null;
  const meta = [
    ...new Set([
      ...ancestors(source),
      ...ancestors(program),
      ...ancestors(run),
      ...(extra ? ancestors(extra) : []),
    ]),
  ]
    .map((path) => `(literal ${sbpl(path)})`)
    .join(" ");
  const execute = [
    `(literal ${sbpl(program)})`,
    `(subpath ${sbpl(source)})`,
    ...(extra ? [`(subpath ${sbpl(extra)})`] : []),
  ].join(" ");
  const read = [
    `(subpath ${sbpl(source)})`,
    `(subpath ${sbpl(run)})`,
    `(literal ${sbpl(program)})`,
    ...(extra ? [`(subpath ${sbpl(extra)})`] : []),
  ].join(" ");
  const network =
    proxyPort && Number.isInteger(proxyPort) && proxyPort > 0 && proxyPort <= 65535
      ? `(allow network-outbound (remote tcp "localhost:${proxyPort}"))`
      : "";
  return `(version 1)\n(deny default)\n(allow process-exec ${execute})\n(allow signal (target same-sandbox))\n(allow sysctl-read)\n(allow file-read* (literal "/"))\n(allow file-read-metadata (literal "/etc") (literal "/tmp") (literal "/var") ${meta})\n(allow file-read* (subpath "/usr") (subpath "/bin") (subpath "/System") (subpath "/private/etc") (subpath "/private/var/db/timezone") (subpath "/opt/homebrew") (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random") ${read})\n(deny file-read* file-write* (subpath "/Library/Keychains"))\n(allow file-write* (literal "/dev/null") (subpath ${sbpl(run)}))\n${network}\n`;
}

export function argv(loaded: LoadedConnector, interpreter: string): string[] {
  const args = loaded.manifest.run.slice(1).map((arg) => {
    const path = resolve(loaded.root, arg);
    return inside(loaded.root, path) &&
      loaded.files.some((entry) => entry.path === arg.replace(/^\.\//, ""))
      ? path
      : arg;
  });
  return [interpreter, ...args];
}

export function snapshot(loaded: LoadedConnector, destination: string): LoadedConnector {
  mkdirSync(destination, { mode: 0o700 });
  for (const entry of loaded.files) {
    const from = join(loaded.root, entry.path);
    const to = join(destination, entry.path);
    mkdirSync(resolve(to, ".."), { recursive: true, mode: 0o700 });
    const source = lstatSync(from);
    if (!source.isFile() || source.nlink !== 1 || source.size !== entry.size)
      throw new ConnectorFault("changed", "approved code changed");
    copyFileSync(from, to, constants.COPYFILE_EXCL);
    chmodSync(to, entry.executable ? 0o700 : 0o600);
  }
  const image = scanConnector(destination);
  if (image.contentSha256 !== loaded.contentSha256)
    throw new ConnectorFault("changed", "approved code changed");
  return image;
}

export async function confinedProcess(
  args: string[],
  profile: string,
  cwd: string,
  input: Buffer,
  timeoutMs: number,
  deno = false,
  proxyPort?: number,
): Promise<{ code: number | null; stdout: Buffer; overflow: boolean; timedOut: boolean }> {
  return new Promise((resolveResult) => {
    const child = spawn("/usr/bin/sandbox-exec", ["-p", profile, ...args], {
      cwd,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        PATH: `/usr/bin:/bin:${resolve(args[0] ?? "/usr/bin", "..")}`,
        HOME: cwd,
        TMPDIR: cwd,
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        PYTHONDONTWRITEBYTECODE: "1",
        PYTHONNOUSERSITE: "1",
        CASHU_CONNECTOR_API: "1",
        ...(proxyPort
          ? {
              HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
              HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
              NO_PROXY: "",
            }
          : {}),
        ...(deno
          ? {
              DENO_DIR: join(cwd, ".deno"),
              DENO_NO_UPDATE_CHECK: "1",
              DENO_NO_PROMPT: "1",
              NO_COLOR: "1",
            }
          : {}),
      },
    });
    const stdout: Buffer[] = [];
    let total = 0;
    let overflow = false;
    let timedOut = false;
    const kill = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* already exited */
        }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_STDOUT) {
        overflow = true;
        kill();
      } else stdout.push(chunk);
    });
    let stderrBytes = 0;
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_STDERR) kill();
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    child.on("error", () => {
      clearTimeout(timer);
      kill();
      resolveResult({ code: null, stdout: Buffer.alloc(0), overflow, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      kill();
      resolveResult({ code, stdout: Buffer.concat(stdout), overflow, timedOut });
    });
  });
}

const DENO_FLAGS = [
  "--no-config",
  "--no-lock",
  "--no-remote",
  "--no-npm",
  "--cached-only",
  "--deny-import",
  "--no-prompt",
  "--no-code-cache",
];
/** A dependency's resolved code or type module; a falsy value means there is none. */
const denoTarget = z
  .union([z.looseObject({ specifier: z.string() }), z.literal([false, 0, ""]), z.null()])
  .optional();
/** `deno info --json` output: only the fields the import confinement reads. */
const denoInfoSchema = z.looseObject({
  roots: z.unknown().optional(),
  // Not z.record: its copy drops an own "__proto__" key, which must reach the URL check.
  redirects: z
    .custom<Readonly<Record<string, unknown>>>(
      (value) => typeof value === "object" && value !== null && !Array.isArray(value),
    )
    .optional(),
  npmPackages: z
    .unknown()
    .optional()
    .refine((packages) => !Array.isArray(packages) || packages.length === 0),
  modules: z.array(
    z.looseObject({
      specifier: z.string(),
      error: z.unknown().optional(),
      dependencies: z
        .array(
          z.union([
            z.looseObject({ code: denoTarget, type: denoTarget }),
            // An array names no code or type target, so it adds nothing to check.
            z.array(z.unknown()),
          ]),
        )
        .optional(),
    }),
  ),
});

/** Every specifier in the module graph must stay inside the approved snapshot (or be `node:`). */
export function denoGraphProblem(
  value: unknown,
  root: string,
): "forbidden_import" | "module_parse_error" | null {
  const parsed = denoInfoSchema.safeParse(value);
  if (!parsed.success) return "forbidden_import";
  const info = parsed.data;
  const urls: unknown[] = Array.isArray(info.roots) ? [...info.roots] : [];
  if (info.redirects !== undefined)
    urls.push(...Object.keys(info.redirects), ...Object.values(info.redirects));
  let broken = false;
  for (const item of info.modules) {
    urls.push(item.specifier);
    if (item.error) broken = true;
    for (const dependency of item.dependencies ?? []) {
      if (Array.isArray(dependency)) continue;
      for (const target of [dependency.code, dependency.type])
        if (target) urls.push(target.specifier);
    }
  }
  for (const item of urls) {
    if (typeof item !== "string") return "forbidden_import";
    let url: URL;
    try {
      url = new URL(item);
    } catch {
      return "forbidden_import";
    }
    if (url.protocol === "node:") continue;
    if (
      url.protocol !== "file:" ||
      (url.hostname && url.hostname !== "localhost") ||
      !inside(root, decodeURIComponent(url.pathname))
    )
      return "forbidden_import";
  }
  return broken ? "module_parse_error" : null;
}

export async function denoArguments(
  loaded: LoadedConnector,
  interpreter: string,
  runDir: string,
  profile: string,
  proxyPort?: number,
): Promise<string[] | RunResult> {
  const script = argv(loaded, interpreter)[1];
  if (
    !script ||
    !inside(loaded.root, script) ||
    !statSync(script, { throwIfNoEntry: false })?.isFile()
  )
    return { outcome: "refused", errorKind: "forbidden_import" };
  if ([loaded.root, runDir].some((path) => path.includes(",")))
    return { outcome: "refused", errorKind: "forbidden_import" };
  const info = await confinedProcess(
    [interpreter, "info", "--json", "--no-config", "--no-lock", "--no-remote", "--no-npm", script],
    profile,
    runDir,
    Buffer.alloc(0),
    20_000,
    true,
  );
  if (info.code !== 0 || info.timedOut || info.overflow || info.stdout.length > 8 * 1024 * 1024)
    return { outcome: "refused", errorKind: "forbidden_import" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(info.stdout.toString("utf8"));
  } catch {
    return { outcome: "refused", errorKind: "forbidden_import" };
  }
  const problem = denoGraphProblem(parsed, loaded.root);
  if (problem) return { outcome: "refused", errorKind: problem };
  return [
    interpreter,
    "run",
    ...DENO_FLAGS,
    `--allow-read=${loaded.root},${runDir}`,
    `--allow-write=${runDir}`,
    ...(proxyPort
      ? [
          `--allow-net=${[
            ...(loaded.manifest.fetch?.hosts.map((host) => `${host}:443`) ?? []),
            `127.0.0.1:${proxyPort}`,
          ].join(",")}`,
        ]
      : []),
    script,
    ...argv(loaded, interpreter).slice(2),
  ];
}

export function parseResponse(
  command: ConnectorCommand,
  code: number | null,
  stdout: Buffer,
): RunResult {
  if (code !== 0 && code !== 1) return { outcome: "failed", errorKind: "protocol" };
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(stdout);
    const parsed: unknown = JSON.parse(text, (_key, value: unknown) => {
      if (typeof value === "number" && !Number.isFinite(value)) throw new Error("nonfinite number");
      return value;
    });
    if (code === 1) {
      const error = errorResponse.parse(parsed);
      return { outcome: "failed", errorKind: error.error.kind };
    }
    const response = (
      command === "detect" ? detectResponse : command === "check" ? checkResponse : documentResponse
    ).parse(parsed);
    if (command === "convert" || command === "fetch") {
      const exact = parseJson(text);
      if (!exact.ok || !(exact.value instanceof Map))
        return { outcome: "failed", errorKind: "protocol" };
      const document = exact.value.get("document");
      if (!(document instanceof Map)) return { outcome: "failed", errorKind: "protocol" };
      return {
        outcome: "ok",
        response: { cursor: "cursor" in response ? (response.cursor ?? null) : null },
        documentBytes: Buffer.from(encodeExact(document), "utf8"),
      };
    }
    return { outcome: "ok", response };
  } catch {
    return { outcome: "failed", errorKind: "protocol" };
  }
}

function encodeExact(value: JsonValue): string {
  if (value instanceof Decimal || typeof value === "bigint") return value.toString();
  if (value instanceof Map)
    return `{${[...value].map(([key, item]) => `${JSON.stringify(key)}:${encodeExact(item)}`).join(",")}}`;
  if (Array.isArray(value)) return `[${value.map(encodeExact).join(",")}]`;
  return JSON.stringify(value);
}

/** Runs only previously approved code through the native sandbox. */
export async function runConnector(options: RunOptions): Promise<RunResult> {
  if (
    process.platform !== "darwin" ||
    !statSync("/usr/bin/sandbox-exec", { throwIfNoEntry: false })?.isFile()
  )
    return { outcome: "refused", errorKind: "sandbox_unavailable" };
  let loaded: LoadedConnector;
  try {
    loaded = options.catalog.approved(options.id, options.interpreter);
  } catch (error) {
    return {
      outcome: "refused",
      errorKind:
        error instanceof ConnectorFault && error.kind === "missing" ? "missing" : "not_approved",
    };
  }
  const isFile = options.command === "detect" || options.command === "convert";
  if ((loaded.manifest.kind === "file") !== isFile)
    return { outcome: "refused", errorKind: "bad_request" };
  if (isFile && !options.file) return { outcome: "refused", errorKind: "bad_request" };
  const extension = options.file ? extname(options.file.name).slice(1).toLowerCase() : "";
  if (isFile && !loaded.manifest.file?.extensions.includes(extension))
    return { outcome: "refused", errorKind: "bad_request" };
  let input: string | undefined;
  if (isFile && options.file) {
    try {
      input = realpathSync.native(options.file.path);
      const stat = lstatSync(input);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_INPUT)
        return { outcome: "refused", errorKind: "bad_request" };
    } catch {
      return { outcome: "refused", errorKind: "bad_request" };
    }
  }
  if (!isFile) {
    const expected = loaded.manifest.fetch?.secrets.map((spec) => spec.id) ?? [];
    if (
      expected.some((id) => !options.secrets?.[id]) ||
      Object.keys(options.secrets ?? {}).some((id) => !expected.includes(id)) ||
      (options.cursor !== undefined && options.cursor !== null && options.cursor.length > 4096) ||
      (options.since !== undefined &&
        options.since !== null &&
        !/^\d{4}-\d{2}-\d{2}$/.test(options.since))
    )
      return { outcome: "refused", errorKind: "bad_request" };
  }
  const runsRoot = join(options.catalog.root, ".runs");
  mkdirSync(runsRoot, { recursive: true, mode: 0o700 });
  const runsStat = lstatSync(runsRoot);
  if (
    !runsStat.isDirectory() ||
    (runsStat.mode & 0o077) !== 0 ||
    realpathSync.native(runsRoot) !== resolve(runsRoot)
  )
    return { outcome: "refused", errorKind: "sandbox_unavailable" };
  const base = mkdtempSync(join(runsRoot, "run-"));
  chmodSync(base, 0o700);
  const runDir = join(base, "run");
  mkdirSync(runDir, { mode: 0o700 });
  let proxy: ConnectorEgressProxy | undefined;
  try {
    let copy: string | undefined;
    if (input) {
      copy = join(runDir, `input.${extension}`);
      copyFileSync(input, copy, constants.COPYFILE_EXCL);
      if (lstatSync(copy).size > MAX_INPUT) return { outcome: "refused", errorKind: "bad_request" };
    }
    // The process sees only a rehashed private copy, never mutable installed code.
    const code = snapshot(loaded, join(base, "code"));
    const executable = loaded.manifest.run[0]?.startsWith("./")
      ? join(code.root, loaded.manifest.run[0].slice(2))
      : options.interpreter;
    const request = {
      api_version: 1,
      command: options.command,
      module: loaded.manifest.module,
      ...(copy && options.file ? { file: { path: copy, name: basename(options.file.name) } } : {}),
      ...(options.account ? { account: options.account } : {}),
      params: options.params ?? {},
      ...(!isFile ? { secrets: options.secrets ?? {} } : {}),
      ...(options.command === "fetch"
        ? { since: options.since ?? null, cursor: options.cursor ?? null }
        : {}),
    };
    let proxyPort: number | undefined;
    if (!isFile) {
      proxy = new ConnectorEgressProxy(loaded.manifest.fetch?.hosts ?? []);
      proxyPort = await proxy.start();
    }
    const profile = macProfile(code.root, executable, runDir, proxyPort);
    const commandArgs =
      loaded.manifest.run[0] === "deno"
        ? await denoArguments(code, executable, runDir, profile, proxyPort)
        : argv(code, executable);
    if (!Array.isArray(commandArgs)) return commandArgs;
    const processResult = await confinedProcess(
      commandArgs,
      profile,
      runDir,
      Buffer.from(JSON.stringify(request)),
      (options.command === "detect" ? 10 : loaded.manifest.timeout_s) * 1000,
      loaded.manifest.run[0] === "deno",
      proxyPort,
    );
    if (processResult.timedOut) return { outcome: "timeout", errorKind: "timeout" };
    if (processResult.overflow) return { outcome: "failed", errorKind: "protocol" };
    return parseResponse(options.command, processResult.code, processResult.stdout);
  } catch (error) {
    return {
      outcome: error instanceof ConnectorFault ? "refused" : "failed",
      errorKind: error instanceof ConnectorFault ? "not_approved" : "spawn_failed",
    };
  } finally {
    if (proxy) await proxy.close();
    rmSync(base, { recursive: true, force: true });
  }
}
