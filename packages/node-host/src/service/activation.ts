import type { HostService } from "./types.js";

export type ActivationOutcome = "service" | "detached";

/**
 * Only call this from connectOrStart's `start` callback, after its retryable connection failure.
 * A handshake refusal is final in connectOrStart and must never reach this function.
 */
export async function activateHost(
  service: Pick<HostService, "status" | "start">,
  startDetached: () => void | Promise<void>,
): Promise<ActivationOutcome> {
  try {
    const status = await service.status();
    if (status.state === "enabled") {
      const outcome = await service.start();
      if (outcome.kind === "started") return "service";
    }
  } catch {
    // An unavailable status bridge or failed service activation permits detached startup.
  }
  await startDetached();
  return "detached";
}
