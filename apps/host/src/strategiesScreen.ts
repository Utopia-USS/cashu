/** Injected-only strategy documents. No directory is inferred from a renderer path or profile slug. */
import { randomUUID } from "node:crypto";
import { STRATEGY_TEMPLATE_NAMES, strategyTemplate } from "@cashu/domain/investments/strategy";
import type { Command } from "@cashu/store";
import { mintUlid } from "@cashu/store";
import type { CurrentStrategyImage } from "@cashu/store/investments/screen-sources";
import {
  discoverStrategies,
  readStrategyFile,
  readStrategyFiles,
  type StrategyDoc,
  type StrategyDocsDir,
  type StrategyFileName,
  type StrategyFilesPort,
  strategySummary,
} from "@cashu/store/investments/services";
import {
  ensureReloadProxy,
  type StrategyDocumentsImage,
  type StrategyDocumentsSource,
  type StrategyInitResult,
  type StrategyReloadResult,
  type StrategySelection,
  saveStrategyVersion,
} from "@cashu/store/investments/strategies-screen";
import type { UiActionResult } from "@cashu/store/ui-actions";
import { z } from "zod";

import {
  defineUiAction,
  type UiActionBinding,
  type UiActionContext,
  type UiActionRegistration,
  unknownUiCommand,
} from "./uiActions.js";

interface StrategyCreateAbsent {
  create(name: StrategyFileName, text: string): Promise<{ readonly status: "created" | "exists" }>;
}
export interface StrategyScreenCapability {
  readonly vault: string;
  readonly generation: string;
  readonly documents: StrategyDocsDir;
  filePath?(document: StrategyDoc, relative: string): Promise<string | null>;
  readonly files: StrategyFilesPort;
  readonly paths?: { readonly yaml: string; readonly md: string; readonly folder: string };
  readonly createAbsent?: StrategyCreateAbsent;
  /** Must revoke on loaded-vault replacement, module/policy change and private file authority loss. */
  isCurrent(): boolean;
  watch?(changed: () => void): () => void;
}
const expected = z.strictObject({ revision: z.string().min(1).max(100) });
const selection = expected.extend({
  document: z.string().min(1).max(64),
  path: z.string().min(1).max(1024),
});
const same = (a: CurrentStrategyImage["files"], b: CurrentStrategyImage["files"]) =>
  a.yaml === b.yaml && a.md === b.md && a.readError === b.readError;

export function strategiesScreen(options: {
  bind(vault: string): StrategyScreenCapability | null;
  publish(image: CurrentStrategyImage): boolean;
  revoke(vault: string): void;
}) {
  let closed = false;
  const images = new Map<string, StrategyDocumentsImage>();
  const fileImages = new Map<string, CurrentStrategyImage>();
  const preparations = new Map<string, Promise<StrategyDocumentsImage>>();
  const pendingPreparations = new Map<string, number>();
  const runs = new Map<string, number>();
  const actionCounts = new Map<string, number>();
  const dirty = new Set<string>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const watches = new Map<string, () => void>();
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of [...listeners]) listener();
  };
  const revoke = (vault: string) => {
    runs.set(vault, (runs.get(vault) ?? 0) + 1);
    const timer = timers.get(vault);
    if (timer) clearTimeout(timer);
    timers.delete(vault);
    dirty.delete(vault);
    watches.get(vault)?.();
    watches.delete(vault);
    images.delete(vault);
    fileImages.delete(vault);
    options.revoke(vault);
    emit();
  };
  const source: StrategyDocumentsSource = {
    changes: {
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    current(read) {
      const vault = read<{ gid: string }>("SELECT gid FROM profiles")[0]?.gid;
      const image = vault ? images.get(vault) : undefined;
      const cap = vault ? options.bind(vault) : null;
      return !closed && image && cap?.isCurrent() && cap.generation === image.generation
        ? image
        : null;
    },
  };
  const schedule = (cap: StrategyScreenCapability) => {
    if (closed || !cap.isCurrent()) return;
    dirty.add(cap.vault);
    if (actionCounts.get(cap.vault) || timers.has(cap.vault)) return;
    timers.set(
      cap.vault,
      setTimeout(() => {
        timers.delete(cap.vault);
        if (actionCounts.get(cap.vault)) return;
        dirty.delete(cap.vault);
        void refresh(cap, images.get(cap.vault)?.loaded?.at(-1)?.requested ?? null).catch(() => {});
      }, 25),
    );
  };
  async function refresh(cap: StrategyScreenCapability, picked: StrategySelection | null = null) {
    const count = pendingPreparations.get(cap.vault) ?? 0;
    if (count >= 8) throw new Error("strategy_preparation_busy");
    pendingPreparations.set(cap.vault, count + 1);
    const previous = preparations.get(cap.vault);
    const job = (previous ?? Promise.resolve()).catch(() => {}).then(() => refreshNow(cap, picked));
    preparations.set(cap.vault, job);
    try {
      return await job;
    } finally {
      const left = (pendingPreparations.get(cap.vault) ?? 1) - 1;
      if (left > 0) pendingPreparations.set(cap.vault, left);
      else pendingPreparations.delete(cap.vault);
      if (preparations.get(cap.vault) === job) preparations.delete(cap.vault);
    }
  }
  async function refreshNow(cap: StrategyScreenCapability, picked: StrategySelection | null) {
    const run = (runs.get(cap.vault) ?? 0) + 1;
    runs.set(cap.vault, run);
    const current = () =>
      !closed &&
      cap.isCurrent() &&
      options.bind(cap.vault)?.generation === cap.generation &&
      runs.get(cap.vault) === run;
    if (!current()) throw new Error("authority_lost");
    try {
      const before = await readStrategyFiles(cap.files);
      if (!current()) throw new Error("authority_lost");
      const docs = await discoverStrategies(cap.documents);
      const summaries = [];
      for (const doc of docs) {
        if (!current()) throw new Error("authority_lost");
        summaries.push(await strategySummary(cap.documents, doc));
      }
      const previous = images.get(cap.vault);
      const requests = [
        ...(previous?.generation === cap.generation ? (previous.loaded ?? []) : [])
          .map((entry) => entry.requested)
          .filter((requested) => JSON.stringify(requested) !== JSON.stringify(picked)),
        picked,
      ].slice(-8);
      const loaded: NonNullable<StrategyDocumentsImage["loaded"]>[number][] = [];
      for (const requested of requests) {
        if (!current()) throw new Error("authority_lost");
        const doc =
          docs.find((d) => d.id === requested?.document) ??
          docs.find((d) => d.files.length > 0) ??
          docs[0];
        const path = doc?.files.includes(requested?.path ?? "")
          ? requested?.path
          : (doc?.mainMd ?? doc?.files[0]);
        const chosen = doc && path ? { document: doc.id, path } : null;
        if (!doc || !chosen) {
          loaded.push({ requested, file: null });
          continue;
        }
        const result = await readStrategyFile(cap.documents, doc, chosen.path);
        const file = result.ok
          ? {
              status: "ready" as const,
              selection: chosen,
              text: result.text,
              ...(cap.filePath ? { absolutePath: await cap.filePath(doc, chosen.path) } : {}),
            }
          : { status: result.reason, selection: chosen };
        if (result.ok && chosen.document === "_main" && before.readError === null) {
          const text =
            chosen.path === "strategy.yaml"
              ? before.yaml
              : chosen.path === "strategy.md"
                ? before.md
                : result.text;
          if (text !== result.text) throw new Error("stale_revision");
        }
        // Check the selected bytes again after asynchronous traversal; no mixed source annotations.
        const verify = await readStrategyFile(cap.documents, doc, chosen.path);
        if (JSON.stringify(result) !== JSON.stringify(verify)) throw new Error("stale_revision");
        loaded.push({ requested, file });
      }
      const selected =
        loaded.find((entry) => JSON.stringify(entry.requested) === JSON.stringify(picked))?.file ??
        null;
      const verifiedDocs = await discoverStrategies(cap.documents);
      if (JSON.stringify(docs) !== JSON.stringify(verifiedDocs)) throw new Error("stale_revision");
      for (const [index, doc] of verifiedDocs.entries()) {
        if (!current()) throw new Error("authority_lost");
        const summary = await strategySummary(cap.documents, doc);
        if (JSON.stringify(summary) !== JSON.stringify(summaries[index]))
          throw new Error("stale_revision");
      }
      const after = await readStrategyFiles(cap.files);
      if (!same(before, after)) throw new Error("stale_revision");
      if (!current()) throw new Error("authority_lost");
      const prior = fileImages.get(cap.vault);
      const selectedChanged = loaded.some((entry) => {
        const old = previous?.loaded?.find(
          (item) => JSON.stringify(item.requested) === JSON.stringify(entry.requested),
        );
        return old !== undefined && JSON.stringify(old.file) !== JSON.stringify(entry.file);
      });
      const revision =
        prior?.generation === cap.generation &&
        same(prior.files, after) &&
        JSON.stringify(images.get(cap.vault)?.documents) === JSON.stringify(summaries) &&
        !selectedChanged
          ? prior.revision
          : randomUUID();
      const image = { vault: cap.vault, generation: cap.generation, revision, files: after };
      const main = docs.find((d) => d.id === "_main");
      const snapshot: StrategyDocumentsImage = {
        vault: cap.vault,
        generation: cap.generation,
        revision,
        documents: summaries,
        selected,
        loaded,
        paths: cap.paths ?? null,
        yamlExists: main?.files.includes("strategy.yaml") ?? false,
        mdExists: main?.files.includes("strategy.md") ?? false,
        canReload: true,
        canInit: cap.createAbsent !== undefined,
      };
      fileImages.set(cap.vault, image);
      images.set(cap.vault, snapshot);
      if (!options.publish(image)) {
        revoke(cap.vault);
        throw new Error("authority_lost");
      }
      emit();
      if (!watches.has(cap.vault) && cap.watch)
        watches.set(
          cap.vault,
          cap.watch(() => schedule(cap)),
        );
      return snapshot;
    } catch (error) {
      if (runs.get(cap.vault) === run) revoke(cap.vault);
      throw error;
    }
  }
  const binding = (vault: string): UiActionBinding<StrategyScreenCapability> | null => {
    const cap = options.bind(vault);
    return cap && cap.vault === vault
      ? {
          generation: cap.generation,
          capabilities: cap,
          isCurrent: () =>
            !closed && cap.isCurrent() && options.bind(vault)?.generation === cap.generation,
        }
      : null;
  };
  const refused = (reason: string) => ({
    status: "refused" as const,
    reason,
    preparation: "none" as const,
  });
  async function reload(
    context: UiActionContext<StrategyScreenCapability>,
    revision: string,
  ): Promise<UiActionResult<StrategyReloadResult>> {
    if (images.get(context.vault)?.revision !== revision) return refused("stale_revision");
    const cap = context.capabilities;
    const snapshot = await refresh(
      cap,
      images.get(context.vault)?.loaded?.at(-1)?.requested ?? null,
    );
    if (!context.isCurrent() || snapshot.revision !== revision) return refused("stale_revision");
    const image = fileImages.get(context.vault);
    if (!image || image.files.readError)
      return {
        status: "completed" as const,
        value: { status: "read_failed", revision: snapshot.revision },
      };
    if (image.files.yaml === null)
      return {
        status: "completed" as const,
        value: { status: "missing", revision: snapshot.revision },
      };
    const check = await readStrategyFiles(cap.files);
    if (!context.isCurrent() || !same(image.files, check)) {
      revoke(context.vault);
      return refused("stale_revision");
    }
    const result = await context.execute({
      command: saveStrategyVersion.id,
      input: { yamlText: check.yaml, mdText: check.md },
      key: mintUlid(Date.now()),
    });
    if (result.kind === "outcome_unknown") return unknownUiCommand(result, saveStrategyVersion.id);
    if (result.kind === "not_started")
      return { status: "not_started", reason: "capability_unavailable" };
    if (result.kind === "refused") return refused(result.reason);
    try {
      const proxy = await context.execute({
        command: ensureReloadProxy.id,
        input: { yamlText: check.yaml, mdText: check.md },
        key: mintUlid(Date.now()),
      });
      if (proxy.kind === "outcome_unknown") return unknownUiCommand(proxy, ensureReloadProxy.id);
    } catch {
      /* Proxy failure never undoes a successfully recorded version. */
    }
    const latest = await context.readStep(
      (read) =>
        read<{ version: number }>(
          "SELECT version FROM inv_strategy_versions ORDER BY version DESC LIMIT 1",
        )[0]?.version ?? null,
    );
    if ((result.value as { recorded: boolean }).recorded) {
      if (latest === null)
        return {
          status: "completed",
          value: {
            status: "not_recorded",
            revision: snapshot.revision,
            reason: "version_readback_missing",
          },
        };
      return {
        status: "completed",
        value: { status: "recorded", revision: snapshot.revision, version: latest },
      };
    }
    return {
      status: "completed",
      value: { status: "unchanged", revision: snapshot.revision, version: latest },
    };
  }
  const commands = [
    saveStrategyVersion as Command<unknown, unknown>,
    ensureReloadProxy as Command<unknown, unknown>,
  ];
  const guard = (read: import("@cashu/store/query").Read, prepared: { input: unknown }) => {
    // The immutable intent must still equal the manager's current authorized image.
    const input = prepared.input as { yamlText?: unknown; mdText?: unknown };
    const vault = read<{ gid: string }>("SELECT gid FROM profiles")[0]?.gid;
    const image = vault ? fileImages.get(vault) : undefined;
    return (
      image !== undefined &&
      options.bind(image.vault)?.isCurrent() === true &&
      options.bind(image.vault)?.generation === image.generation &&
      image.files.yaml === input.yamlText &&
      image.files.md === input.mdText
    );
  };
  const actions = [
    defineUiAction({
      id: "investments.strategies.refresh",
      input: z.strictObject({}),
      module: "investments",
      bind: binding,
      async run(context) {
        const image = await refresh(context.capabilities);
        return { status: "completed", value: { revision: image.revision } };
      },
    }),
    defineUiAction({
      id: "investments.strategies.readFile",
      input: selection,
      module: "investments",
      bind: binding,
      async run(context, input) {
        if (images.get(context.vault)?.revision !== input.revision)
          return refused("stale_revision");
        const image = await refresh(context.capabilities, {
          document: input.document,
          path: input.path,
        });
        return {
          status: "completed",
          value: { status: image.selected?.status ?? "no_file", revision: image.revision },
        };
      },
    }),
    defineUiAction({
      id: "investments.strategies.reload",
      input: expected,
      module: "investments",
      bind: binding,
      commands,
      beforeExecute: guard,
      run: (context, input) => reload(context, input.revision),
    }),
    defineUiAction({
      id: "investments.strategies.init",
      input: expected,
      module: "investments",
      bind: binding,
      commands,
      beforeExecute: guard,
      async run(context, input): Promise<UiActionResult<StrategyInitResult>> {
        if (images.get(context.vault)?.revision !== input.revision)
          return refused("stale_revision");
        const cap = context.capabilities;
        if (!cap.createAbsent) return refused("capability_unavailable");
        const fresh = await refresh(cap);
        if (!context.isCurrent()) return refused("authority_lost");
        if (fresh.yamlExists || fresh.mdExists) return refused("files_exist");
        if (fresh.revision !== input.revision) return refused("stale_revision");
        const template = strategyTemplate(STRATEGY_TEMPLATE_NAMES[0]);
        if (!template) return refused("unknown_template");
        const written: StrategyFileName[] = [];
        try {
          for (const [name, text] of [
            ["strategy.yaml", template.yaml],
            ["strategy.md", template.markdown],
          ] as const) {
            if (!context.isCurrent())
              return {
                status: "completed",
                value: { status: "recovery_required", reason: "authority_lost", written },
              };
            const result = await cap.createAbsent.create(name, text);
            if (!context.isCurrent()) {
              revoke(context.vault);
              return {
                status: "completed",
                value: { status: "recovery_required", reason: "authority_lost", written },
              };
            }
            if (result.status === "exists") {
              const image = await refresh(cap);
              if (written.length === 0) return refused("files_exist");
              return {
                status: "completed",
                value: {
                  status: "partial_files",
                  reason: "files_exist",
                  written,
                  revision: image.revision,
                },
              };
            }
            written.push(name);
          }
          const image = await refresh(cap);
          const result = await reload(context, image.revision);
          if (result.status === "outcome_unknown" || result.status === "not_started") return result;
          if (
            result.status === "completed" &&
            (result.value.status === "recorded" || result.value.status === "unchanged") &&
            result.value.version !== null
          ) {
            return {
              status: "completed",
              value: {
                status: "created_and_recorded",
                revision: image.revision,
                version: result.value.version,
              },
            };
          }
          return {
            status: "completed",
            value: {
              status: "files_created_not_recorded",
              written,
              revision: image.revision,
              reason: result.status === "completed" ? result.value.status : "record_failed",
            },
          };
        } catch {
          if (written.length === 2 && context.isCurrent()) {
            try {
              const image = await refresh(cap);
              return {
                status: "completed",
                value: {
                  status: "files_created_not_recorded",
                  written,
                  revision: image.revision,
                  reason: "record_failed",
                },
              };
            } catch {
              /* Authorized readback could not establish the current files. */
            }
          }
          revoke(context.vault);
          return {
            status: "completed",
            value: { status: "recovery_required", reason: "readback_required", written },
          };
        }
      },
    }),
  ];
  return {
    source,
    actions: actions.map(
      (action): UiActionRegistration => ({
        ...action,
        async run(stores, vault, input, sessionCurrent) {
          actionCounts.set(vault, (actionCounts.get(vault) ?? 0) + 1);
          try {
            return await action.run(stores, vault, input, sessionCurrent);
          } finally {
            const count = (actionCounts.get(vault) ?? 1) - 1;
            if (count > 0) actionCounts.set(vault, count);
            else {
              actionCounts.delete(vault);
              const cap = options.bind(vault);
              if (cap && dirty.has(vault)) schedule(cap);
            }
          }
        },
      }),
    ),
    async prepare(vault: string, selected: StrategySelection | null = null) {
      const cap = options.bind(vault);
      if (cap && cap.vault === vault) {
        const parsed = z
          .strictObject({ document: z.string().min(1).max(64), path: z.string().min(1).max(1024) })
          .nullable()
          .safeParse(selected);
        if (!parsed.success) throw new Error("invalid_selection");
        await refresh(cap, parsed.data);
      }
    },
    revoke,
    close() {
      closed = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      dirty.clear();
      for (const stop of watches.values()) stop();
      watches.clear();
      for (const vault of images.keys()) revoke(vault);
      listeners.clear();
    },
  };
}
