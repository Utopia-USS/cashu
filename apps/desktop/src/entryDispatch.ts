/** Select a one-shot helper before importing any ordinary desktop startup module. */
export async function dispatchDesktopEntry(
  args: readonly string[],
  actions: {
    registerAppScheme?(): void;
    registerEarlyResponses(): void;
    loadMain(): Promise<unknown>;
    runHelper(): Promise<number>;
  },
): Promise<number | null> {
  if (args.length === 1 && args[0] === "--notify-helper") {
    try {
      return await actions.runHelper();
    } catch {
      return 2;
    }
  }
  if (args.includes("--notify-helper")) return 2;
  actions.registerAppScheme?.();
  actions.registerEarlyResponses();
  await actions.loadMain();
  return null;
}
