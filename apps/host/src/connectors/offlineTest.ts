import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { budget, core } from "@cashu/domain";
import {
  reportCorporateActionCount,
  reportPositionCount,
  reportTxnCount,
  validateImportFile,
} from "@cashu/domain/investments/importing";
import { resolveInterpreter } from "./catalog.js";
import { validateConnectorDocument } from "./document.js";
import { inside, scanConnector } from "./manifest.js";
import {
  argv,
  confinedProcess,
  denoArguments,
  MAX_INPUT,
  macProfile,
  parseResponse,
  snapshot,
} from "./runner.js";

export interface OfflineFileTestInput {
  readonly workspaceRoot: string;
  readonly connectorPath: string;
  readonly samplePath?: string;
  readonly fixturePath?: string;
  /** Private host-owned scratch directory. No other profile or source files are mounted. */
  readonly scratchRoot: string;
  isCurrent(): boolean;
  now?(): number;
}
export interface OfflineFileTestReport {
  readonly ok: boolean;
  readonly id: string | null;
  readonly version: string | null;
  readonly interpreter: string | null;
  readonly module: string | null;
  readonly kind: string | null;
  readonly detect: boolean | null;
  readonly documentValid: boolean | null;
  readonly errorKind: string | null;
  readonly records: number;
  readonly runs: readonly {
    readonly command: "detect" | "convert" | "fetch";
    readonly outcome: "ok" | "failed";
    readonly errorKind: string | null;
    readonly records: number;
  }[];
  readonly document: {
    readonly format: string;
    readonly counts: Readonly<Record<string, number>>;
    readonly issueKinds: readonly string[];
  } | null;
}
const registry = core.builtinRegistry();
const KNOWN_KINDS = new Set([
  "authority_lost",
  "bad_request",
  "bad_file",
  "unsupported_version",
  "auth_failed",
  "rate_limited",
  "network",
  "upstream",
  "internal",
  "protocol",
  "timeout",
  "sandbox_unavailable",
  "spawn_failed",
  "forbidden_import",
  "module_parse_error",
  "invalid_document",
  "oversized_document",
  "changed",
]);
const safeKind = (kind: string): string => (KNOWN_KINDS.has(kind) ? kind : "internal");
const refused = (kind: string): OfflineFileTestReport => ({
  ok: false,
  id: null,
  version: null,
  interpreter: null,
  module: null,
  kind: null,
  detect: null,
  documentValid: null,
  errorKind: safeKind(kind),
  records: 0,
  runs: [],
  document: null,
});

function checked(path: string, root: string): string {
  if (!path || path.includes("\0")) throw new Error("invalid_path");
  const base = realpathSync.native(root);
  if (base !== resolve(root) || lstatSync(root).isSymbolicLink()) throw new Error("invalid_root");
  const target = realpathSync.native(resolve(base, path));
  const rel = relative(base, target);
  if (
    !rel ||
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    !inside(base, target) ||
    rel.split(sep).some((part) => part.startsWith("."))
  )
    throw new Error("invalid_path");
  return target;
}

/** Unapproved code only: a no-network sandbox run with a checked sample or recorded fixture. */
export async function testConnectorOffline(
  input: OfflineFileTestInput,
): Promise<OfflineFileTestReport> {
  if (!input.isCurrent()) return refused("authority_lost");
  if (
    process.platform !== "darwin" ||
    !statSync("/usr/bin/sandbox-exec", { throwIfNoEntry: false })?.isFile()
  )
    return refused("sandbox_unavailable");
  let base: string | undefined;
  try {
    if (Boolean(input.samplePath) === Boolean(input.fixturePath)) return refused("bad_request");
    const workspace = realpathSync.native(input.workspaceRoot);
    const source = checked(input.connectorPath, join(workspace, "connectors"));
    const sample = checked(input.samplePath ?? input.fixturePath ?? "", workspace);
    const sourceStat = lstatSync(source);
    const sampleStat = lstatSync(sample);
    if (
      !sourceStat.isDirectory() ||
      !sampleStat.isFile() ||
      sampleStat.nlink !== 1 ||
      sampleStat.size === 0 ||
      sampleStat.size > (input.fixturePath ? 1024 * 1024 : MAX_INPUT) ||
      basename(source) !== scanConnector(source).manifest.id
    )
      return refused("bad_request");
    const loaded = scanConnector(source);
    const runs: {
      command: "detect" | "convert" | "fetch";
      outcome: "ok" | "failed";
      errorKind: string | null;
      records: number;
    }[] = [];
    const failed = (kind: string, detect: boolean | null = null): OfflineFileTestReport => ({
      ...refused(kind),
      id: loaded.manifest.id,
      version: loaded.manifest.version,
      interpreter: loaded.manifest.run[0] ?? null,
      module: loaded.manifest.module,
      kind: loaded.manifest.kind,
      detect,
      runs,
    });
    if (
      (loaded.manifest.kind === "file") !== Boolean(input.samplePath) ||
      (input.samplePath &&
        !loaded.manifest.file?.extensions.includes(extname(sample).slice(1).toLowerCase())) ||
      (input.fixturePath && extname(sample).toLowerCase() !== ".json")
    )
      return failed("bad_request");
    const interpreter = resolveInterpreter(loaded);
    const scratch = realpathSync.native(input.scratchRoot);
    const scratchStat = lstatSync(scratch);
    if (!scratchStat.isDirectory() || (scratchStat.mode & 0o077) !== 0)
      return failed("sandbox_unavailable");
    base = mkdtempSync(join(scratch, "offline-"));
    const runDir = join(base, "run");
    mkdirSync(runDir, { mode: 0o700 });
    const fd = openSync(sample, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let bytes: Buffer;
    try {
      const current = fstatSync(fd);
      if (
        !current.isFile() ||
        current.nlink !== 1 ||
        current.size !== sampleStat.size ||
        current.ino !== sampleStat.ino ||
        current.dev !== sampleStat.dev
      )
        return failed("changed");
      bytes = readFileSync(fd);
    } finally {
      closeSync(fd);
    }
    if (bytes.length !== sampleStat.size || !input.isCurrent()) return failed("authority_lost");
    if (input.fixturePath) {
      try {
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch {
        return failed("bad_request");
      }
    }
    const file = join(runDir, `input.${extname(sample).slice(1).toLowerCase()}`);
    writeFileSync(file, bytes, { mode: 0o600, flag: "wx" });
    const code = snapshot(loaded, join(base, "code"));
    const executable = loaded.manifest.run[0]?.startsWith("./")
      ? join(code.root, loaded.manifest.run[0].slice(2))
      : interpreter;
    const profile = macProfile(code.root, executable, runDir);
    const args =
      loaded.manifest.run[0] === "deno"
        ? await denoArguments(code, executable, runDir, profile)
        : argv(code, executable);
    if (!Array.isArray(args)) return failed(args.outcome === "ok" ? "bad_request" : args.errorKind);
    const run = async (command: "detect" | "convert" | "fetch") => {
      if (!input.isCurrent()) return null;
      const since = new Date(
        (input.now?.() ?? Date.now()) - (code.manifest.fetch?.history_days ?? 365) * 86_400_000,
      )
        .toISOString()
        .slice(0, 10);
      const request = {
        api_version: 1,
        command,
        module: code.manifest.module,
        ...(command === "fetch"
          ? {
              params: { fixture: bytes.toString("utf8") },
              secrets: Object.fromEntries(
                (code.manifest.fetch?.secrets ?? []).map((item) => [
                  item.id,
                  "test-not-a-real-secret",
                ]),
              ),
              since,
              cursor: null,
            }
          : { file: { path: file, name: basename(sample) }, params: {} }),
      };
      const process = await confinedProcess(
        args,
        profile,
        runDir,
        Buffer.from(JSON.stringify(request)),
        Math.min(command === "detect" ? 10 : code.manifest.timeout_s, 120) * 1000,
        code.manifest.run[0] === "deno",
      );
      if (process.timedOut) return { outcome: "timeout" as const, errorKind: "timeout" };
      if (process.overflow) return { outcome: "failed" as const, errorKind: "protocol" };
      return parseResponse(command, process.code, process.stdout);
    };
    let match: boolean | null = null;
    if (input.samplePath) {
      const detected = await run("detect");
      runs.push({
        command: "detect",
        outcome: detected?.outcome === "ok" ? "ok" : "failed",
        errorKind:
          detected?.outcome === "ok" ? null : safeKind(detected?.errorKind ?? "authority_lost"),
        records: 0,
      });
      if (detected?.outcome !== "ok") return failed(detected?.errorKind ?? "authority_lost");
      match = (detected.response as { match: boolean }).match;
    }
    const converted = await run(input.fixturePath ? "fetch" : "convert");
    const command = input.fixturePath ? "fetch" : "convert";
    runs.push({
      command,
      outcome: converted?.outcome === "ok" ? "ok" : "failed",
      errorKind:
        converted?.outcome === "ok" ? null : safeKind(converted?.errorKind ?? "authority_lost"),
      records: 0,
    });
    if (!converted) return failed("authority_lost", match);
    if (converted.outcome !== "ok") return failed(converted.errorKind, match);
    if (!converted.documentBytes) return failed("protocol", match);
    const document = validateConnectorDocument(code.manifest.module, converted.documentBytes);
    const summary =
      code.manifest.module === "budget"
        ? (() => {
            const parsed = budget.parseBudgetDocument(converted.documentBytes, "connector.json", {
              registry: registry.institutions,
              source: "connector",
            });
            return {
              format: parsed.variant,
              counts: { transactions: parsed.transactionCount, balances: parsed.closingCount },
              issueKinds: [...new Set(parsed.issues.map((issue) => issue.kind))].sort(),
            };
          })()
        : (() => {
            const parsed = validateImportFile({
              name: "connector.json",
              content: converted.documentBytes,
            });
            return {
              format: "cashu-import",
              counts: {
                transactions: reportTxnCount(parsed),
                positions: reportPositionCount(parsed),
                corporate_actions: reportCorporateActionCount(parsed),
              },
              issueKinds: [
                ...new Set(
                  [...parsed.errors, ...parsed.warnings]
                    .map((issue) => issue.kind)
                    .filter((kind) => /^[a-z_]{1,48}$/.test(kind)),
                ),
              ].sort(),
            };
          })();
    runs[runs.length - 1] = {
      command,
      outcome: document.ok ? "ok" : "failed",
      errorKind: document.ok ? null : document.code,
      records: summary.counts.transactions,
    };
    if (!input.isCurrent()) return refused("authority_lost");
    return {
      ok: document.ok,
      id: code.manifest.id,
      version: code.manifest.version,
      interpreter: code.manifest.run[0] ?? null,
      module: code.manifest.module,
      kind: code.manifest.kind,
      detect: match,
      documentValid: document.ok,
      errorKind: document.ok ? null : document.code,
      records: summary.counts.transactions,
      runs,
      document: summary,
    };
  } catch {
    return refused("bad_request");
  } finally {
    if (base) rmSync(base, { recursive: true, force: true });
  }
}

export const testConnectorFileOffline = testConnectorOffline;
