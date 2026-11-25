// "Plan the notifications again now": raised where the planner's inputs change outside the device
// settings it watches (the notification permission was just granted). The shell's planner listens.

const listeners = new Set<() => void>();

export function requestReplan(): void {
  for (const listener of listeners) listener();
}

export function onReplanRequested(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
