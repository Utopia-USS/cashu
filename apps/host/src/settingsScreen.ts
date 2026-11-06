import { builtinRegistry } from "@cashu/domain/core";
import { enabledModuleIds } from "@cashu/store/core";
import { type WorkspaceStatusState, workspaceStatus } from "@cashu/store/core/desktop-settings";
import { defineQuery, type Read } from "@cashu/store/query";
import { z } from "zod";
import { watchDirectory } from "./connectors/directoryWatch.js";
import type { HostStores, OpenVault } from "./stores.js";
import type { UiActionRegistration } from "./uiActions.js";
import type {
  WorkspaceBinding,
  WorkspaceInspectInput,
  WorkspaceProvider,
  WorkspaceStatus,
} from "./workspace/index.js";

const registry = builtinRegistry();
const applyInput = z.object({
  path: z.string().max(4096).optional(),
  force: z.boolean().optional(),
  routinePermissions: z.boolean().optional(),
});

/** The profile context a workspace inspection depends on, read through `read` (a query then follows it). */
function context(read: Read): WorkspaceInspectInput | null {
  const profile = read<{
    slug: string;
    baseCurrency: string;
    mcpPrivacy: string;
  }>("SELECT slug, base_currency AS baseCurrency, mcp_privacy AS mcpPrivacy FROM profiles")[0];
  if (!profile || !["strict", "amounts"].includes(profile.mcpPrivacy)) return null;
  const enabled = enabledModuleIds(read);
  return {
    slug: profile.slug,
    baseCurrency: profile.baseCurrency,
    privacy: profile.mcpPrivacy as "strict" | "amounts",
    modules: [...registry.modules.values()]
      .filter((module) => enabled.has(module.id))
      .map((module) => ({ id: module.id, name: module.name })),
  };
}
const vaultContext = (vault: OpenVault) => context(vault.store.read.bind(vault.store));

/** The workspace write is available only through a current exact-vault provider. */
export function settingsWorkspaceActions(
  provider?: WorkspaceProvider,
): readonly UiActionRegistration[] {
  return [
    {
      id: "core.settings.workspaceApply",
      async run(stores: HostStores, target: string, raw: unknown, sessionCurrent = () => true) {
        const parsed = applyInput.safeParse(raw);
        if (!parsed.success)
          return { status: "refused", reason: "invalid_input", preparation: "none" };
        const vault = stores.vaults.get(target);
        if (!vault) return { status: "refused", reason: "unknown_target", preparation: "none" };
        const binding = provider?.bind(target);
        if (!binding?.isCurrent())
          return { status: "refused", reason: "capability_unavailable", preparation: "none" };
        const current = () =>
          sessionCurrent() &&
          stores.vaults.get(target) === vault &&
          provider?.bind(target)?.generation === binding.generation &&
          binding.isCurrent();
        const source = vaultContext(vault);
        if (!source) return { status: "refused", reason: "no_profile", preparation: "none" };
        const fingerprint = JSON.stringify(source);
        const operationCurrent = () =>
          current() && JSON.stringify(vaultContext(vault)) === fingerprint;
        if (!operationCurrent())
          return { status: "refused", reason: "authority_lost", preparation: "none" };
        try {
          const value = await binding.apply({
            ...source,
            ...parsed.data,
            isCurrent: operationCurrent,
          });
          if (!operationCurrent()) return { status: "outcome_unknown", reason: "interrupted" };
          return { status: "completed", value };
        } catch {
          return { status: "outcome_unknown", reason: "unexpected_failure" };
        }
      },
    },
  ];
}

interface Wanted {
  readonly vault: OpenVault;
  readonly binding: WorkspaceBinding;
  readonly input: WorkspaceInspectInput;
  /** Binding generation and profile context: an image for another key is stale. */
  readonly key: string;
}

/**
 * The served `workspaceStatus` query: each vault's workspace inspected asynchronously while a Settings screen
 * listens, and inspected again after a workspace write (provider changes), a profile context change (the query
 * reads it, so a change re-runs it) or a change in the workspace folder on disk (a directory watch on the
 * inspected path, which also waits for a folder that does not exist yet).
 */
export function settingsWorkspaceStatus(input: {
  readonly provider: WorkspaceProvider;
  stores(): HostStores | null;
  readonly watch?: typeof watchDirectory;
}) {
  const watch = input.watch ?? watchDirectory;
  const listeners = new Set<() => void>();
  const images = new Map<
    string,
    { readonly vault: OpenVault; key: string; readonly status: WorkspaceStatus }
  >();
  const wanted = new Map<string, Wanted>();
  const checking = new Set<string>();
  const scheduled = new Set<string>();
  const again = new Set<string>();
  const watches = new Map<string, { readonly path: string; readonly stop: () => void }>();
  let stopProvider: (() => void) | undefined;
  const emit = () => {
    for (const listener of [...listeners]) listener();
  };
  /** Mark the vault's image stale; the re-run query asks for a fresh inspection. */
  const invalidate = (id: string) => {
    const image = images.get(id);
    if (image) image.key = "";
    if (checking.has(id)) again.add(id);
    emit();
  };
  const follow = (id: string, status: WorkspaceStatus) => {
    const path = status.availability === "ready" ? status.path : null;
    const current = watches.get(id);
    if (current?.path === path) return;
    current?.stop();
    watches.delete(id);
    if (path !== null) watches.set(id, { path, stop: watch(path, () => invalidate(id)) });
  };
  const check = (id: string) => {
    if (checking.has(id)) {
      again.add(id);
      return;
    }
    const request = wanted.get(id);
    if (!request?.binding.isCurrent()) return;
    checking.add(id);
    void request.binding
      .inspect(request.input)
      .catch(
        (): WorkspaceStatus => ({
          availability: "unavailable",
          reason: "workspace_inspect_failed",
        }),
      )
      .then((status) => {
        checking.delete(id);
        if (listeners.size === 0) return;
        if (again.delete(id) || wanted.get(id) !== request) {
          check(id);
          return;
        }
        images.set(id, { vault: request.vault, key: request.key, status });
        follow(id, status);
        emit();
      });
  };
  const state = (read: Read): WorkspaceStatusState => {
    const id = read<{ gid: string }>("SELECT gid FROM profiles")[0]?.gid;
    const unbound = (reason: string): WorkspaceStatusState => ({
      status: "ready",
      workspace: { availability: "unavailable", reason },
      checking: false,
    });
    if (id === undefined) return unbound("no_profile");
    const inspectInput = context(read);
    const vault = input.stores()?.vaults.get(id);
    const binding = input.provider.bind(id);
    if (!vault || !binding?.isCurrent()) return unbound("source_unbound");
    if (!inspectInput) return unbound("no_profile");
    const key = JSON.stringify([binding.generation, inspectInput]);
    const image = images.get(id);
    const known = image?.vault === vault ? image : undefined;
    if (known?.key === key) return { status: "ready", workspace: known.status, checking: false };
    if (wanted.get(id)?.key !== key || !checking.has(id)) {
      wanted.set(id, { vault, binding, input: inspectInput, key });
      if (!scheduled.has(id)) {
        scheduled.add(id);
        queueMicrotask(() => {
          scheduled.delete(id);
          check(id);
        });
      }
    }
    return known
      ? { status: "ready", workspace: known.status, checking: true }
      : { status: "loading" };
  };
  const stopAll = () => {
    stopProvider?.();
    stopProvider = undefined;
    for (const { stop } of watches.values()) stop();
    watches.clear();
    images.clear();
    wanted.clear();
  };
  return defineQuery({
    id: workspaceStatus.id,
    changes: {
      subscribe(listener) {
        if (listeners.size === 0)
          stopProvider = input.provider.changes?.subscribe((id) => invalidate(id));
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
          if (listeners.size === 0) stopAll();
        };
      },
    },
    run: (read, _args: undefined) => state(read),
  });
}
