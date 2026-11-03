type DesktopServiceState = "off" | "enabled" | "requires_approval" | "unavailable" | "error";
export interface DesktopServiceStatus {
  readonly state: DesktopServiceState;
  readonly reason?: string;
  readonly nextWake?: string;
}

interface ServiceBridge {
  status(): Promise<unknown>;
  setEnabled(enabled: boolean): Promise<unknown>;
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

/** Serializes status reads against a registration change, preserving the provider's actual result. */
export function createServiceStatusCoordinator(
  onStatus: (status: DesktopServiceStatus) => void,
  read: () => Promise<DesktopServiceStatus> = readServiceStatus,
  set: (enabled: boolean) => Promise<DesktopServiceStatus> = setServiceEnabled,
) {
  let revision = 0;
  let mutating = false;
  let deferred = false;
  const poll = async (): Promise<void> => {
    if (mutating) {
      deferred = true;
      return;
    }
    const request = ++revision;
    const status = await read();
    if (!mutating && request === revision) onStatus(status);
  };
  return {
    get busy() {
      return mutating;
    },
    invalidate() {
      revision++;
    },
    poll,
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
      if (deferred) {
        deferred = false;
        if (status.state !== "error") await poll();
      }
      return status;
    },
  };
}
