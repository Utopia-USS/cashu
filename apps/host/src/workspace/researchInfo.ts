/** Async workspace inspection projected into the synchronous Research query. */
import { builtinRegistry } from "@cashu/domain/core";
import { enabledModuleIds } from "@cashu/store/core";
import type {
  ResearchImageSource,
  ResearchWorkspaceInfo,
} from "@cashu/store/investments/research-screen";
import type { Read } from "@cashu/store/query";
import type { OpenVault } from "../stores.js";
import type { WorkspaceBinding, WorkspaceInspectInput, WorkspaceProvider } from "./index.js";

const registry = builtinRegistry();

function context(vault: OpenVault): WorkspaceInspectInput | null {
  const profile = vault.store.read<{
    slug: string;
    baseCurrency: string;
    privacy: string;
  }>("SELECT slug, base_currency AS baseCurrency, mcp_privacy AS privacy FROM profiles")[0];
  if (!profile || (profile.privacy !== "strict" && profile.privacy !== "amounts")) return null;
  const enabled = enabledModuleIds(vault.store.read.bind(vault.store));
  return {
    slug: profile.slug,
    baseCurrency: profile.baseCurrency,
    privacy: profile.privacy,
    modules: [...registry.modules.values()]
      .filter((module) => enabled.has(module.id))
      .map((module) => ({ id: module.id, name: module.name })),
  };
}

interface Image {
  readonly vault: OpenVault;
  readonly binding: WorkspaceBinding;
  readonly context: string;
  readonly revision: string;
  readonly info: ResearchWorkspaceInfo | null;
  readonly unavailableReason: string;
}

/** Inspection runs asynchronously; current() only checks identity and the last image. */
export function createResearchWorkspaceInfo(input: {
  readonly provider: WorkspaceProvider;
  readonly vaults: ReadonlyMap<string, OpenVault>;
  isCurrent(vault: OpenVault): boolean;
}): {
  readonly source: ResearchImageSource<ResearchWorkspaceInfo>;
  invalidate(vault: string): void;
  refresh(vault: string): Promise<void>;
  close(): void;
} {
  const listeners = new Set<() => void>();
  const images = new Map<string, Image>();
  const epochs = new Map<string, number>();
  const scheduled = new Set<string>();
  const running = new Map<string, Promise<void>>();
  const dirty = new Set<string>();
  let revision = 0;
  let closed = false;
  const changed = () => {
    if (!closed) for (const listener of [...listeners]) listener();
  };
  const validVault = (id: string, vault: OpenVault) =>
    !closed && vault.mode === "native" && input.vaults.get(id) === vault && input.isCurrent(vault);
  const schedule = (id: string) => {
    if (closed || scheduled.has(id) || running.has(id)) return;
    scheduled.add(id);
    queueMicrotask(() => {
      scheduled.delete(id);
      if (!closed && !running.has(id)) void refresh(id);
    });
  };
  const invalidate = (id: string) => {
    epochs.set(id, (epochs.get(id) ?? 0) + 1);
    if (images.delete(id)) changed();
    if (running.has(id)) dirty.add(id);
    else schedule(id);
  };
  const inspectOnce = async (id: string): Promise<void> => {
    const vault = input.vaults.get(id);
    if (!vault || !validVault(id, vault)) return;
    const source = context(vault);
    const binding = input.provider.bind(id);
    if (!source || !binding?.isCurrent()) return;
    const fingerprint = JSON.stringify(source);
    const epoch = epochs.get(id) ?? 0;
    let info: ResearchWorkspaceInfo | null = null;
    let unavailableReason = "inspect_unavailable";
    try {
      const status = await binding.inspect(source);
      if (status.availability === "unavailable") unavailableReason = "workspace_unavailable";
      if (status.availability === "ready" && status.conflict === null) {
        const skill = status.skills.find((item) => item.name === "market-research");
        info = {
          path: status.path,
          exists: status.exists,
          skillInstalled:
            status.exists &&
            skill !== undefined &&
            (skill.state === "ok" || skill.state === "outdated" || skill.state === "modified"),
          command: status.exists ? status.claudeCommand : null,
          routine: status.exists ? status.routineCommand : null,
        };
      }
    } catch {
      // The query exposes a fixed code, never an exception message or workspace path.
      unavailableReason = "workspace_inspect_failed";
      process.emitWarning("workspace_research_inspect_failed");
    }
    if (
      !validVault(id, vault) ||
      !binding.isCurrent() ||
      (epochs.get(id) ?? 0) !== epoch ||
      JSON.stringify(context(vault)) !== fingerprint
    ) {
      // An initial image can go stale without provider invalidation. Coalesce one follow-up
      // only while a replacement vault, context and binding are currently usable.
      const replacement = input.vaults.get(id);
      if (
        replacement &&
        validVault(id, replacement) &&
        context(replacement) &&
        input.provider.bind(id)?.isCurrent()
      )
        dirty.add(id);
      return;
    }
    const image: Image = {
      vault,
      binding,
      context: fingerprint,
      revision: String(++revision),
      info,
      unavailableReason,
    };
    images.set(id, image);
    changed();
  };
  const refresh = (id: string): Promise<void> => {
    if (closed) return Promise.resolve();
    const active = running.get(id);
    if (active) {
      dirty.add(id);
      return active;
    }
    // The first pass and at most one queued rerun run serially per vault.
    const work = (async () => {
      do {
        dirty.delete(id);
        await inspectOnce(id);
      } while (!closed && dirty.has(id));
    })();
    running.set(id, work);
    void work.then(
      () => running.delete(id),
      () => {
        running.delete(id);
        process.emitWarning("workspace_research_refresh_failed");
      },
    );
    return work;
  };
  const stopChanges = input.provider.changes?.subscribe((id) => invalidate(id));
  return {
    source: {
      changes: {
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      current(read: Read) {
        if (closed) return { status: "unavailable", reason: "source_closed" };
        const id = read<{ gid: string }>("SELECT gid FROM profiles")[0]?.gid;
        if (!id) return { status: "unavailable", reason: "invalid_identity" };
        const vault = input.vaults.get(id);
        if (!vault || !validVault(id, vault))
          return { status: "unavailable", reason: "capability_unavailable" };
        const image = images.get(id);
        const fingerprint = JSON.stringify(context(vault));
        if (
          !image ||
          image.vault !== vault ||
          !image.binding.isCurrent() ||
          image.context !== fingerprint
        ) {
          if (image) invalidate(id);
          else schedule(id);
          return { status: "unavailable", reason: "source_unbound" };
        }
        if (!image.info) return { status: "unavailable", reason: image.unavailableReason };
        return {
          status: "current",
          value: {
            vault: id,
            generation: image.binding.generation,
            revision: image.revision,
            value: image.info,
          },
        };
      },
    },
    invalidate,
    refresh,
    close() {
      closed = true;
      stopChanges?.();
      images.clear();
      listeners.clear();
    },
  };
}
