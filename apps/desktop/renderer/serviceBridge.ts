type DesktopServiceState = "off" | "enabled" | "requires_approval" | "unavailable" | "error";
export interface DesktopServiceStatus {
  readonly state: DesktopServiceState;
  readonly reason?: string;
  readonly nextWake?: string;
}

interface ServiceBridge {
  status(): Promise<unknown>;
  setEnabled(enabled: boolean): Promise<unknown>;
  /** Main pushes the status it re-checked (window focus); returns the unsubscribe function. */
  onStatus(handler: (status: unknown) => void): () => void;
}

declare global {
  interface Window {
    readonly cashuService?: ServiceBridge;
  }
}

const unavailable: DesktopServiceStatus = { state: "unavailable" };

export function parseServiceStatus(value: unknown): DesktopServiceStatus {
  if (!value || typeof value !== "object" || !("state" in value)) return unavailable;
  const raw = value as Record<string, unknown>;
  if (
    !(["off", "enabled", "requires_approval", "unavailable", "error"] as unknown[]).includes(
      raw.state,
    )
  ) {
    return unavailable;
  }
  const state = raw.state as DesktopServiceState;
  return {
    state,
    ...(typeof raw.reason === "string" ? { reason: raw.reason } : {}),
    ...(state === "enabled" &&
    typeof raw.nextWake === "string" &&
    !Number.isNaN(Date.parse(raw.nextWake))
      ? { nextWake: raw.nextWake }
      : {}),
  };
}

export async function readServiceStatus(): Promise<DesktopServiceStatus> {
  try {
    return parseServiceStatus(await window.cashuService?.status());
  } catch {
    return { state: "error" };
  }
}

export async function setServiceEnabled(enabled: boolean): Promise<DesktopServiceStatus> {
  if (!window.cashuService) return unavailable;
  try {
    return parseServiceStatus(await window.cashuService.setEnabled(enabled));
  } catch {
    return { state: "error" };
  }
}

/** Statuses main pushes after re-checking the registration (no renderer timer asks again). */
export function onServiceStatus(handler: (status: DesktopServiceStatus) => void): () => void {
  return window.cashuService?.onStatus((raw) => handler(parseServiceStatus(raw))) ?? (() => {});
}

/**
 * Orders the first status read and main's pushes against a registration change: a toggle in flight
 * owns the result (main's push and an older read lose), preserving the provider's actual result.
 */
export function createServiceStatusCoordinator(
  onStatus: (status: DesktopServiceStatus) => void,
  read: () => Promise<DesktopServiceStatus> = readServiceStatus,
  set: (enabled: boolean) => Promise<DesktopServiceStatus> = setServiceEnabled,
) {
  let revision = 0;
  let mutating = false;
  return {
    get busy() {
      return mutating;
    },
    invalidate() {
      revision++;
    },
    /** The status once, when the screen opens; later values arrive through `pushed`. */
    async load(): Promise<void> {
      if (mutating) return;
      const request = ++revision;
      const status = await read();
      if (!mutating && request === revision) onStatus(status);
    },
    /** A status main pushed; newer than any read still in flight. */
    pushed(status: DesktopServiceStatus): void {
      if (mutating) return;
      revision++;
      onStatus(status);
    },
    async toggle(enabled: boolean): Promise<DesktopServiceStatus | null> {
      if (mutating) return null;
      mutating = true;
      revision++;
      let status: DesktopServiceStatus;
      try {
        status = await set(enabled);
      } catch {
        status = { state: "error" };
      }
      onStatus(status);
      mutating = false;
      return status;
    },
  };
}
