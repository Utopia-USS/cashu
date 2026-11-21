/** Checked, injected research snapshots. This module grants no file or network authority. */
import type { market } from "@cashu/domain/investments";
import type * as macro from "@cashu/domain/investments/macro";
import type {
  ResearchImageSource,
  ResearchScreenExtraSources,
  ResearchWorkspaceInfo,
} from "@cashu/store/investments/research-screen";

export interface ResearchScreenCapability {
  readonly vault: string;
  readonly generation: string;
  isCurrent(): boolean;
  readonly macro?: { readonly revision: string; readonly closes: macro.MacroCloses };
  readonly calendar?: { readonly revision: string; readonly feeds: market.CalendarFeeds };
  readonly workspace?: { readonly revision: string; readonly info: ResearchWorkspaceInfo };
}

/** The caller owns refresh and calls changed only after committing a new checked image. */
export function researchScreenSources(
  bind: (vault: string) => ResearchScreenCapability | null,
): ResearchScreenExtraSources & { changed(): void; close(): void } {
  const listeners = new Set<() => void>();
  let closed = false;
  const changes = {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const source = <T>(
    pick: (cap: ResearchScreenCapability) => { revision: string; value: T } | undefined,
  ): ResearchImageSource<T> => ({
    changes,
    current(read) {
      if (closed) return { status: "unavailable", reason: "source_closed" };
      const vault = read<{ gid: string }>("SELECT gid FROM profiles")[0]?.gid;
      if (!vault) return { status: "unavailable", reason: "invalid_identity" };
      const cap = bind(vault);
      if (!cap || cap.vault !== vault || !cap.generation || !cap.isCurrent())
        return { status: "unavailable", reason: "capability_unavailable" };
      const selected = pick(cap);
      if (!selected || !selected.revision)
        return { status: "unavailable", reason: "source_unbound" };
      return {
        status: "current",
        value: {
          vault,
          generation: cap.generation,
          revision: selected.revision,
          value: selected.value,
        },
      };
    },
  });
  return {
    macro: source((cap) => cap.macro && { revision: cap.macro.revision, value: cap.macro.closes }),
    calendar: source(
      (cap) => cap.calendar && { revision: cap.calendar.revision, value: cap.calendar.feeds },
    ),
    workspace: source(
      (cap) => cap.workspace && { revision: cap.workspace.revision, value: cap.workspace.info },
    ),
    changed() {
      if (!closed) for (const listener of [...listeners]) listener();
    },
    close() {
      closed = true;
      listeners.clear();
    },
  };
}
