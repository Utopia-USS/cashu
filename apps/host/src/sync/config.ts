// TRANSITIONAL(S49): the host's outbox bridge (S31a spec 2.2, 2.3, D3a; S56c: a host service).
//
// The bridge's configuration: `<data dir>/sync-bridge.json` of the host's data dir (the Python data
// dir whose `cashu.db` the bridge reads); no file, no sync service. Strict, absolute paths only, and
// the refusals checked before anything is opened: every path outside the owner's real data dir,
// workspaces and installed app, none inside a git work tree, the outputs never inside the Python data
// dir, and the lab key files only under `<home>/cashu-lab` (TRANSITIONAL(S56e): a file key store
// exists only in the lab; the OS keyring adapter and pairing (S44) replace the file). Refusal
// messages name the setting, never a path or a value.
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { RefusalError, refusePaths, resolveReal } from "@cashu/node-host";
import { z } from "zod";

const abs = z.string().refine(isAbsolute, { message: "an absolute path" });

/** The bridge configuration's file name in the host's data dir. */
export const BRIDGE_CONFIG_FILE = "sync-bridge.json";

const configSchema = z.strictObject({
  /** 2 (S56c): the data dir is the host's own, no longer a field. */
  format: z.literal(2),
  /** The `cashu` command and the environment it runs with (the lab: a safe env over the run). */
  python: z.strictObject({
    argv: z.array(z.string().min(1)).min(1),
    env: z.record(z.string(), z.string()),
  }),
  stateRoot: abs,
  remotes: z.array(z.strictObject({ kind: z.literal("folder"), root: abs })),
  keys: z.strictObject({
    kind: z.literal("lab-file"),
    /** This device's vault rings and identities (lab key store, 0600). */
    path: abs,
    /** Python's keyring file (the lab `FileKeyring` backend): the gid salt entry for Python. */
    pythonKeyring: abs,
  }),
  /** How often the service looks at Python's outbox (a change wakes the loop). */
  pollMs: z.int().positive().default(2000),
  /** The carrier loop: a full iteration (push, pull, pipe) at least this often, changes or not. */
  carrierMs: z.int().positive().default(60_000),
});

export type BridgeConfig = z.infer<typeof configSchema> & {
  /** The host's data dir (the Python data dir). */
  readonly dataDir: string;
};

/** Throws `RefusalError` unless `path` resolves inside `<home>/cashu-lab`. */
function refuseOutsideLab(label: string, path: string, home: string): void {
  const lab = resolveReal(join(home, "cashu-lab"));
  const rel = relative(lab.toLowerCase(), resolveReal(path).toLowerCase());
  if (rel === "" || rel.startsWith("..") || rel.startsWith(sep) || isAbsolute(rel)) {
    throw new RefusalError(`${label} must be inside the lab root (lab key store only)`);
  }
}

/**
 * The validated configuration of the data dir's bridge after every refusal; undefined when the data
 * dir has none (the service stays off).
 */
export function loadConfig(dataDir: string, home: string): BridgeConfig | undefined {
  const path = join(dataDir, BRIDGE_CONFIG_FILE);
  if (!existsSync(path)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new RefusalError("the config file cannot be read as JSON");
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) throw new RefusalError("the config file does not validate");
  const config = { ...parsed.data, dataDir };
  refusePaths(
    {
      dataDir: { label: "dataDir", path: dataDir },
      outputs: [
        { label: "stateRoot", path: config.stateRoot },
        { label: "keys.path", path: config.keys.path },
        { label: "keys.pythonKeyring", path: config.keys.pythonKeyring },
        ...config.remotes.map((r, i) => ({ label: `remotes[${i}]`, path: r.root })),
      ],
    },
    home,
  );
  refuseOutsideLab("keys.path", config.keys.path, home);
  refuseOutsideLab("keys.pythonKeyring", config.keys.pythonKeyring, home);
  return config;
}
