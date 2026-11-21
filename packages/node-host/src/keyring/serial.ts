// One in-process queue per keyring namespace: mutations of one namespace (a KEK's first creation, a
// sealed blob's replacement) run one after another, so two writers never both see "no key" and race
// to create it. Across processes the held host lock gives the same guarantee.
const mutationQueues = new Map<string, Promise<unknown>>();

/** Runs `operation` after every earlier operation queued under `namespace` has settled. */
export function serializeNamespace<T>(namespace: string, operation: () => Promise<T>): Promise<T> {
  const previous = mutationQueues.get(namespace) ?? Promise.resolve();
  const next = previous.then(operation, operation);
  const settled = next.catch(() => undefined);
  mutationQueues.set(namespace, settled);
  void settled.then(() => {
    if (mutationQueues.get(namespace) === settled) mutationQueues.delete(namespace);
  });
  return next;
}
