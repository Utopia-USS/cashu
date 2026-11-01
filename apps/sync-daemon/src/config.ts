// TRANSITIONAL(S49): the lab / dev host of the outbox bridge (S31a spec 2.2, 2.3, D3a): the production
// loop runs in the desktop utility process once the Python app is retired or wrapped (S47).
//
// The daemon's configuration file (strict, absolute paths only) and the refusals checked before
// anything is opened (exit 64): every path outside the owner's real data dir, workspaces and
// installed app, none inside a git work tree, the outputs never inside the Python data dir, and the
// lab key files only under `<home>/cashu-lab` (TRANSITIONAL(S47): a file key store exists only in
// the lab). Refusal messages name the setting, never a path or a value.
import { readFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { RefusalError, refusePaths, resolveReal } from "@cashu/node-host";
import { z } from "zod";

const abs = z.string().refine(isAbsolute, { message: "an absolute path" });

const configSchema = z.strictObject({
  format: z.literal(1),
  /** The Python data dir (`CASHU_DATA_DIR`) whose `cashu.db` the daemon reads. */
  dataDir: abs,
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
  pollMs: z.int().positive().default(2000),
});

export type DaemonConfig = z.infer<typeof configSchema>;

/** Throws `RefusalError` unless `path` resolves inside `<home>/cashu-lab`. */
function refuseOutsideLab(label: string, path: string, home: string): void {
  const lab = resolveReal(join(home, "cashu-lab"));
  const rel = relative(lab.toLowerCase(), resolveReal(path).toLowerCase());
  if (rel === "" || rel.startsWith("..") || rel.startsWith(sep) || isAbsolute(rel)) {
    throw new RefusalError(`${label} must be inside the lab root (lab key store only)`);
  }
}

/** The validated configuration, after every refusal. */
export function loadConfig(path: string, home: string): DaemonConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new RefusalError("the config file cannot be read as JSON");
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) throw new RefusalError("the config file does not validate");
  const config = parsed.data;
  refusePaths(
    {
      dataDir: { label: "dataDir", path: config.dataDir },
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
