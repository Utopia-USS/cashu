// "Remove this phone": the wipe's order (pure, tested in Node over fakes; `wipeThisPhone` in services.ts
// binds it to the platform). Wipe first, explain after: every step that is safe to run runs even when an
// earlier one fails, the root is always remounted, and the first failure is reported last, only when the
// rebuilt app is shown (the fatal state already says the wipe failed, so nothing more is thrown then).
//
// Order: the root shows "Removing this phone's copy" (the app's tree unmounts, so no render reads a
// store from here on), the before-wipe tasks (our scheduled and delivered notifications), the Keychain
// items (async only: expo-secure-store has no synchronous delete), one frame so the "Removing" state
// reaches the screen, then synchronously close every database, delete the files and rebuild the
// services (the demo's fixture build), and remount. Deleting the key before the files is safe: an
// interrupted wipe leaves files without a key, which the next boot discards (services.ts).
//
// A failed close or delete is not rebuilt over: a database may still be open, and the key is gone. The
// root then shows the fatal "close cashU and open it again" state, as it does when the rebuild throws;
// the next launch discards the files without a key and starts clean.

export type BeforeWipeTask = () => Promise<void> | void;

const beforeWipe = new Set<BeforeWipeTask>();

/**
 * Register a task to run before a wipe (the notification scheduler cancels what it scheduled). Kept
 * outside the services, so a registration made once at startup survives the services' rebuild.
 * Returns the unregister function.
 */
export function onBeforeWipe(task: BeforeWipeTask): () => void {
  beforeWipe.add(task);
  return () => beforeWipe.delete(task);
}

/** The registered before-wipe tasks, in registration order. */
export function beforeWipeTasks(): BeforeWipeTask[] {
  return [...beforeWipe];
}

export interface WipeSteps {
  /** The root shows the "Removing" state instead of the app. */
  showWiping(): void;
  /** Best effort: a failing task does not stop or fail the wipe. */
  readonly beforeWipe: readonly BeforeWipeTask[];
  /** Delete the database key and the KeyStore's key-encryption key from the Keychain. */
  deleteSecrets(): Promise<void>;
  /** Resolve after the "Removing" state has been rendered (before the synchronous work blocks). */
  nextFrame(): Promise<void>;
  /** Close every database of the current services (client, vaults, price cache, device store). */
  close(): void;
  /** Delete every file the app wrote: databases, sealed key files, measurement logs, the language pin. */
  deleteFiles(): void;
  /** Build the services again (fresh, empty files under a new key). */
  reset(): void;
  /** Remount the root: the rebuilt app (`ready`) or the fatal state (`failed`). */
  remount(outcome: "ready" | "failed"): void;
}

/**
 * Run the wipe and return the phase it remounted into. Rejects with the first failure only when the app
 * was rebuilt despite it (a Keychain item that could not be deleted): the caller tells the user to try
 * again. A `failed` remount resolves: the root's fatal state is the report, a second one would repeat it.
 */
export async function wipeDevice(steps: WipeSteps): Promise<"ready" | "failed"> {
  steps.showWiping();
  const failures: unknown[] = [];
  let usable = true;
  try {
    await Promise.allSettled(steps.beforeWipe.map((task) => Promise.resolve().then(task)));
    try {
      await steps.deleteSecrets();
    } catch (error) {
      failures.push(error);
    }
    await steps.nextFrame();
    try {
      steps.close();
      // Only after a full close: expo-sqlite refuses to delete a file it still has open.
      steps.deleteFiles();
    } catch (error) {
      failures.push(error);
      usable = false;
    }
    if (usable) {
      try {
        steps.reset();
      } catch (error) {
        failures.push(error);
        usable = false;
      }
    }
  } finally {
    steps.remount(usable ? "ready" : "failed");
  }
  if (!usable) return "failed";
  if (failures.length > 0) throw failures[0];
  return "ready";
}
