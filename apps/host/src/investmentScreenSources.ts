/** Completed current-file images only; production file authority is supplied by the owner. */
import {
  type CurrentStrategyImage,
  type CurrentStrategySource,
  strategySnapshot,
} from "@cashu/store/investments/screen-sources";

export function currentStrategyImages(isCurrent: (vault: string, generation: string) => boolean) {
  const images = new Map<string, CurrentStrategyImage>();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  const source: CurrentStrategySource = {
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
      const image = vault === undefined ? undefined : images.get(vault);
      if (image === undefined || !isCurrent(image.vault, image.generation))
        return { status: "unavailable", reason: "current_files_unavailable" };
      return strategySnapshot(read, image);
    },
  };
  return {
    source,
    publish(image: CurrentStrategyImage): boolean {
      if (!isCurrent(image.vault, image.generation)) return false;
      const prior = images.get(image.vault);
      if (prior?.generation === image.generation && prior.revision === image.revision) return true;
      images.set(image.vault, { ...image, files: { ...image.files } });
      notify();
      return true;
    },
    revoke(vault: string): void {
      if (images.delete(vault)) notify();
    },
    close(): void {
      images.clear();
      notify();
      listeners.clear();
    },
  };
}
