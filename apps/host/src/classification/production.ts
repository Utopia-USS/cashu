import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { budget } from "@cashu/domain";
import type { HostLock } from "@cashu/node-host";
import {
  type ClassifierSecretAuthority,
  type ClassifierSecretStore,
  createProductionClassifierSecrets,
} from "@cashu/node-host/classifier-secrets";
import {
  type ClassifierSettingsSource,
  type ClassifierSettingsState,
  classifierSettingsSnapshotSchema,
} from "@cashu/store/core/classifier-settings";
import type { UiActionResult } from "@cashu/store/ui-actions";
import { z } from "zod";
import type {
  CategorizeProvider,
  CloudCategorizeProvider,
} from "../cli/budget/categorizeOllama.js";
import { refreshFetchAuthority } from "../fetchAuthority.js";
import type { HostStores, OpenVault } from "../stores.js";
import type { UiActionRegistration } from "../uiActions.js";

const ENDPOINT = "https://api.anthropic.com/v1/messages";
const RECORD = z
  .strictObject({
    revision: z.string().uuid(),
    backend: z.enum(["ollama", "anthropic"]),
    model: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._:-]+$/),
    consent: z.literal("merchant-name-residual-v1").nullable(),
  })
  .refine((value) => (value.backend === "anthropic") === (value.consent !== null));
type RecordState = z.infer<typeof RECORD>;
const ACTION = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("chooseLocal") }),
  z.strictObject({
    op: z.literal("grantCloud"),
    riskCopy: z.literal("merchant-name-residual-v1"),
    model: RECORD.shape.model,
  }),
  z.strictObject({ op: z.literal("revokeCloud") }),
  z.strictObject({ op: z.literal("setKey"), key: z.string().min(1).max(16_384) }),
  z.strictObject({ op: z.literal("clearKey") }),
]);
const DEFAULT: RecordState = Object.freeze({
  revision: "00000000-0000-4000-8000-000000000000",
  backend: "ollama",
  model: budget.ANTHROPIC_DEFAULT_MODEL,
  consent: null,
});

export interface ProductionClassifierOptions {
  readonly dataDir: string;
  readonly lock: HostLock;
  readonly stores: HostStores;
  readonly isCurrentVault: (vault: OpenVault) => boolean;
  /** Test seam only; production uses the dedicated classifier OS service. */
  readonly makeSecrets?: (authority: ClassifierSecretAuthority) => ClassifierSecretStore;
  readonly fetch?: typeof globalThis.fetch;
}

function privateDirectory(path: string): string {
  const resolved = resolve(path);
  const stat = lstatSync(resolved);
  if (
    path !== resolved ||
    realpathSync.native(resolved) !== resolved ||
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())
  )
    throw new Error("classifier_config_unavailable");
  return resolved;
}

/** Host-local nonsecret preferences; fail closed on a changed owner, symlink or malformed record. */
class ConfigFiles {
  private readonly root: string;
  private readonly directory: string;
  private readonly identity: { dev: number; ino: number };
  constructor(dataDir: string) {
    const root = privateDirectory(dataDir);
    this.root = root;
    this.directory = join(root, "classification");
    if (!existsSync(this.directory)) mkdirSync(this.directory, { mode: 0o700 });
    privateDirectory(this.directory);
    const stat = lstatSync(this.directory);
    this.identity = { dev: stat.dev, ino: stat.ino };
  }
  private path(vault: string): string {
    if (!/^[a-f0-9]{32}$/.test(vault)) throw new Error("classifier_config_unavailable");
    privateDirectory(this.root);
    privateDirectory(this.directory);
    const stat = lstatSync(this.directory);
    if (stat.dev !== this.identity.dev || stat.ino !== this.identity.ino)
      throw new Error("classifier_config_unavailable");
    return join(this.directory, `${vault}.json`);
  }
  read(vault: string): RecordState {
    const path = this.path(vault);
    if (!existsSync(path)) return DEFAULT;
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.size > 4096 ||
        (stat.mode & 0o077) !== 0 ||
        (typeof process.getuid === "function" && stat.uid !== process.getuid())
      )
        throw new Error("classifier_config_unavailable");
      const bytes = Buffer.allocUnsafe(stat.size);
      if (readSync(fd, bytes, 0, stat.size, 0) !== stat.size)
        throw new Error("classifier_config_unavailable");
      const after = fstatSync(fd);
      if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size)
        throw new Error("classifier_config_unavailable");
      return RECORD.parse(JSON.parse(bytes.toString("utf8")));
    } finally {
      closeSync(fd);
    }
  }
  write(vault: string, value: RecordState): void {
    const path = this.path(vault);
    // Refuse an existing link before replacement, including a hard-linked target.
    if (existsSync(path)) {
      const stat = lstatSync(path);
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        (stat.mode & 0o077) !== 0 ||
        (typeof process.getuid === "function" && stat.uid !== process.getuid())
      )
        throw new Error("classifier_config_unavailable");
    }
    const temp = join(this.directory, `.${randomUUID()}.tmp`);
    const fd = openSync(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(fd, JSON.stringify(RECORD.parse(value)), "utf8");
      fsyncSync(fd);
      closeSync(fd);
      renameSync(temp, path);
      const dir = openSync(this.directory, "r");
      try {
        fsyncSync(dir);
      } finally {
        closeSync(dir);
      }
    } catch (error) {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
      try {
        unlinkSync(temp);
      } catch {
        /* renamed or absent */
      }
      throw error;
    }
  }
}

/** Construct only after a held real host lock and checked native vaults exist. */
export function createProductionClassifierBinding(options: ProductionClassifierOptions): {
  readonly local: CategorizeProvider;
  readonly cloud: CloudCategorizeProvider;
  readonly action: UiActionRegistration;
  /** The live per-vault settings the Settings panel shows; re-checked after every owner change. */
  readonly settings: ClassifierSettingsSource;
  /** One authenticated check of the file and the key; a stable answer reconciles an interrupted change. */
  inspect(id: string): Promise<UiActionResult<unknown>>;
} {
  const files = new ConfigFiles(options.dataDir);
  const ownerScope = new AsyncLocalStorage<{ vault: string; current: () => boolean }>();
  const generations = new Map<string, number>();
  const unresolved = new Set<string>();
  const busy = new Set<string>();
  const transport = options.fetch ?? globalThis.fetch;
  const currentVault = (id: string): OpenVault | null => {
    const vault = options.stores.vaults.get(id);
    return vault?.mode === "native" &&
      options.lock.held &&
      vault.native.isCurrent() &&
      options.isCurrentVault(vault)
      ? vault
      : null;
  };
  const holder = (id: string) => currentVault(id)?.native?.canFetchPublicMarket() === true;
  // Fresh lease pull evidence before `holder` is checked (../fetchAuthority.ts).
  const refresh = (id: string) => refreshFetchAuthority(currentVault(id) ?? undefined);
  const generation = (id: string) => generations.get(id) ?? 0;
  const invalidate = (id: string) => generations.set(id, generation(id) + 1);
  const read = (id: string): RecordState | null => {
    try {
      return currentVault(id) && !unresolved.has(id) && !busy.has(id) ? files.read(id) : null;
    } catch {
      return null;
    }
  };
  const secrets = (id: string): ClassifierSecretStore => {
    const authority: ClassifierSecretAuthority = {
      dataDir: options.dataDir,
      lock: options.lock,
      vault: id,
      isCurrent: (candidate) => candidate === id && currentVault(id) !== null,
      isOwnerAction: () => {
        const scope = ownerScope.getStore();
        return scope?.vault === id && scope.current();
      },
    };
    return (options.makeSecrets ?? createProductionClassifierSecrets)(authority);
  };
  const local: CategorizeProvider = {
    isHolder: holder,
    refresh,
    fetch: (request, init) => transport(request, init),
  };
  const cloud: CloudCategorizeProvider = {
    isHolder: holder,
    refresh,
    fetch: (request, init) => transport(request, init),
    consent(id) {
      const record = read(id);
      if (record?.backend !== "anthropic" || record.consent !== "merchant-name-residual-v1")
        return null;
      const pinned = generation(id);
      const revision = record.revision;
      return Object.freeze({
        vault: id,
        riskCopy: "merchant-name-residual-v1" as const,
        isCurrent: (candidate: string) =>
          candidate === id &&
          holder(id) &&
          generation(id) === pinned &&
          read(id)?.revision === revision,
      });
    },
    config(id) {
      const record = read(id);
      if (record?.backend !== "anthropic" || record.consent !== "merchant-name-residual-v1")
        return null;
      const pinned = generation(id);
      const revision = record.revision;
      return Object.freeze({
        model: record.model,
        endpoint: ENDPOINT,
        isCurrent: (candidate: string) =>
          candidate === id &&
          holder(id) &&
          generation(id) === pinned &&
          read(id)?.revision === revision,
      });
    },
    credentials: { apiKey: (id) => secrets(id).get() },
  };
  /** A fresh authenticated inspection; a stable answer reconciles an ambiguous prior key/config mutation. */
  const inspect = async (id: string): Promise<UiActionResult<unknown>> => {
    const vault = currentVault(id);
    if (!vault) return { status: "not_started", reason: "capability_unavailable" };
    const current = () => currentVault(id) === vault;
    if (busy.has(id)) return { status: "not_started", reason: "pending_previous_attempt" };
    const pinned = generation(id);
    let record: RecordState;
    try {
      record = files.read(id);
    } catch {
      return { status: "not_started", reason: "capability_unavailable" };
    }
    if (!record) return { status: "not_started", reason: "capability_unavailable" };
    try {
      const keyPresent = !!(await secrets(id).get());
      const stable =
        current() &&
        !busy.has(id) &&
        generation(id) === pinned &&
        files.read(id).revision === record.revision;
      if (stable) unresolved.delete(id);
      return stable
        ? {
            status: "completed",
            value: {
              backend: record.backend,
              model: record.model,
              consented: record.consent === "merchant-name-residual-v1",
              keyPresent,
            },
          }
        : { status: "outcome_unknown", reason: "interrupted" };
    } catch {
      return { status: "not_started", reason: "capability_unavailable" };
    }
  };
  // The Settings panel's live state: each vault is checked once, then again after every owner change (whose
  // `finally` always re-checks, which also reconciles an interrupted one); a check that overlapped a change is
  // superseded by the check that change starts.
  const listeners = new Set<() => void>();
  const images = new Map<string, { vault: OpenVault; state: ClassifierSettingsState }>();
  const checking = new Set<string>();
  const scheduled = new Set<string>();
  const again = new Set<string>();
  const emit = () => {
    for (const listener of [...listeners]) listener();
  };
  const check = (id: string) => {
    if (checking.has(id)) {
      again.add(id);
      return;
    }
    const vault = currentVault(id);
    if (!vault) return;
    checking.add(id);
    void inspect(id)
      .catch((): UiActionResult<unknown> => ({ status: "outcome_unknown", reason: "interrupted" }))
      .then((result) => {
        checking.delete(id);
        if (again.delete(id)) {
          check(id);
          return;
        }
        if (currentVault(id) !== vault) return;
        const snapshot =
          result.status === "completed"
            ? classifierSettingsSnapshotSchema.safeParse(result.value)
            : null;
        if (snapshot?.success)
          images.set(id, { vault, state: { status: "ready", snapshot: snapshot.data } });
        else if (result.status === "not_started" && result.reason === "capability_unavailable")
          images.set(id, { vault, state: { status: "unavailable" } });
        // Busy or overlapped: the change in flight re-checks when it ends.
        else return;
        emit();
      });
  };
  const settings: ClassifierSettingsSource = {
    changes: {
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    state(id) {
      const vault = currentVault(id);
      if (!vault) return { status: "unavailable" };
      const image = images.get(id);
      if (image?.vault === vault) return image.state;
      if (!checking.has(id) && !scheduled.has(id)) {
        scheduled.add(id);
        queueMicrotask(() => {
          scheduled.delete(id);
          if (!checking.has(id)) check(id);
        });
      }
      return { status: "loading" };
    },
  };
  const action: UiActionRegistration = {
    id: "core.settings.classifier",
    async run(stores, id, raw, sessionCurrent = () => true) {
      const parsed = ACTION.safeParse(raw);
      if (!parsed.success)
        return { status: "refused", reason: "invalid_input", preparation: "none" };
      const vault = currentVault(id);
      if (!vault || stores !== options.stores)
        return { status: "not_started", reason: "capability_unavailable" };
      const current = () => sessionCurrent() && currentVault(id) === vault;
      if (!current()) return { status: "refused", reason: "stale_action", preparation: "none" };
      if (busy.has(id) || unresolved.has(id))
        return { status: "not_started", reason: "pending_previous_attempt" };
      busy.add(id);
      invalidate(id); // Revocation/rotation fences every already-issued transport capability immediately.
      try {
        const request = parsed.data;
        if (request.op === "setKey" || request.op === "clearKey") {
          const previous = files.read(id);
          // Persistently disarm cloud before touching the OS credential. An interrupted rotation
          // cannot reactivate old consent after a host restart.
          files.write(id, {
            ...previous,
            revision: randomUUID(),
            backend: "ollama",
            consent: null,
          });
          if (!current()) {
            unresolved.add(id);
            return { status: "outcome_unknown", reason: "interrupted" };
          }
          await ownerScope.run({ vault: id, current }, () =>
            request.op === "setKey" ? secrets(id).set(request.key) : secrets(id).clear(),
          );
          if (!current()) {
            unresolved.add(id);
            return { status: "outcome_unknown", reason: "interrupted" };
          }
        } else {
          const previous = files.read(id);
          if (!previous || !current())
            return { status: "refused", reason: "authority_lost", preparation: "none" };
          if (request.op === "grantCloud") {
            if (!(await secrets(id).get()) || !current())
              return { status: "refused", reason: "no_api_key", preparation: "none" };
          }
          const next: RecordState = {
            revision: randomUUID(),
            backend: request.op === "grantCloud" ? "anthropic" : "ollama",
            model: request.op === "grantCloud" ? request.model : previous.model,
            consent: request.op === "grantCloud" ? request.riskCopy : null,
          };
          files.write(id, next);
          if (!current()) {
            unresolved.add(id);
            return { status: "outcome_unknown", reason: "interrupted" };
          }
        }
        const record = files.read(id);
        const keyPresent = !!(await secrets(id).get());
        if (!current()) {
          unresolved.add(id);
          return { status: "outcome_unknown", reason: "interrupted" };
        }
        return {
          status: "completed",
          value: {
            backend: record?.backend ?? "ollama",
            model: record?.model ?? budget.ANTHROPIC_DEFAULT_MODEL,
            consented: record?.consent === "merchant-name-residual-v1",
            keyPresent,
          },
        };
      } catch {
        unresolved.add(id);
        return { status: "outcome_unknown", reason: "interrupted" };
      } finally {
        invalidate(id);
        busy.delete(id);
        check(id);
      }
    },
  };
  return { local, cloud, action, settings, inspect };
}
