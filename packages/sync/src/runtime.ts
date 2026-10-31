// The few host globals the sync layer relies on, typed locally. They exist on every runtime cashU
// targets (Node >= 22, Electron, Hermes in React Native), but the TypeScript config deliberately has no
// DOM or Node lib: reaching them through this module keeps Node-only APIs out of `packages/sync` and
// works whatever lib the consuming package compiles these sources with.

interface HostGlobals {
  TextEncoder: new () => { encode(input: string): Uint8Array };
  TextDecoder: new (
    label: string,
    options: { fatal: boolean },
  ) => { decode(input: Uint8Array): string };
  queueMicrotask(task: () => void): void;
  setTimeout(task: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const host = globalThis as unknown as HostGlobals;
const encoder = new host.TextEncoder();
const decoder = new host.TextDecoder("utf-8", { fatal: true });

export function utf8Encode(text: string): Uint8Array {
  return encoder.encode(text);
}

/** Strict UTF-8 decode: throws on invalid bytes. */
export function utf8Decode(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

export function queueTask(task: () => void): void {
  host.queueMicrotask(task);
}

/** Resolves `true` when `p` settles first, `false` after `ms`. */
export async function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let handle: unknown;
  const timeout = new Promise<boolean>((resolve) => {
    handle = host.setTimeout(() => resolve(false), ms);
  });
  const done = await Promise.race([p.then(() => true), timeout]);
  host.clearTimeout(handle);
  return done;
}
