// The propagation conformance check (S29c R4): a transport that declares `linearizable` or
// `bounded` consistency (carrier.ts `TransportConsistency`) must show every append to every other
// handle once the declared bound has passed. The fetch lease's automatic mode rests on that claim
// (devices/lease.ts, rule 6), so the claim is tested here, not assumed: the carrier contract suite
// runs this check for every carrier, and a relay (S28d) may declare `bounded` only when it passes.
//
// The check never calls the medium's `settle()` (that would make any backend look consistent). It
// lets time pass only through `elapse(ms)`: a simulated medium advances its clock, an adapter over a
// real service waits. `eventual` declares nothing and passes trivially.

import type { Awaitable, DeviceId, Transport, TransportConsistency, VaultId } from "../carrier.js";
import { propagationBound } from "../carrier.js";

export interface PropagationMedium {
  /** The transport as one device sees it. */
  remoteFor(device: DeviceId): Awaitable<Transport>;
  /**
   * Let `ms` of the medium's time pass. Required to test a non-zero bound; a medium without it can
   * only pass with `linearizable` or `eventual`.
   */
  elapse?(ms: number): Promise<void>;
}

export interface PropagationVerdict {
  readonly declared: TransportConsistency;
  /** False for `eventual`: nothing was claimed, nothing was checked. */
  readonly claimed: boolean;
  readonly ok: boolean;
  /** One line per append a reader did not see in time (empty when ok). */
  readonly violations: readonly string[];
}

// Fixed 32-hex device ids (synthetic).
const WRITERS = [
  "d1111111111111111111111111111111",
  "d2222222222222222222222222222222",
  "d3333333333333333333333333333333",
];

/**
 * Appends `rounds` times through rotating writer handles (growing segments and new ones), waits
 * exactly the declared bound after each append resolved, and checks that every OTHER handle lists
 * the new size and reads the written bytes.
 */
export async function checkPropagationClaim(
  medium: PropagationMedium,
  vault: VaultId,
  rounds = 9,
): Promise<PropagationVerdict> {
  const handles = await Promise.all(WRITERS.map((d) => medium.remoteFor(d)));
  const declared = (handles[0] as Transport).consistency;
  const violations: string[] = [];
  if (handles.some((h) => JSON.stringify(h.consistency) !== JSON.stringify(declared))) {
    violations.push("handles of one medium declare different consistency");
  }
  if (declared.kind === "eventual") {
    return { declared, claimed: false, ok: violations.length === 0, violations };
  }
  const bound = propagationBound(declared);
  if (bound === undefined) {
    violations.push(`invalid propagation bound ${JSON.stringify(declared)}`);
    return { declared, claimed: true, ok: false, violations };
  }
  if (bound > 0 && !medium.elapse) {
    violations.push("a bounded claim needs medium.elapse to be tested");
    return { declared, claimed: true, ok: false, violations };
  }

  // What each segment holds as far as the writers know: "device/seg" -> bytes.
  const written = new Map<string, number[]>();
  for (let round = 0; round < rounds; round++) {
    const w = round % WRITERS.length;
    const device = WRITERS[w] as DeviceId;
    const seg = 1 + (Math.floor(round / WRITERS.length) % 2);
    const key: string = `${device}/${seg}`;
    const before = written.get(key) ?? [];
    const chunk = [round + 1, (round * 7) % 251, 255 - round];
    await (handles[w] as Transport).append(
      vault,
      device,
      seg,
      before.length,
      Uint8Array.from(chunk),
    );
    written.set(key, [...before, ...chunk]);
    if (bound > 0) await medium.elapse?.(bound);
    for (const [r, reader] of handles.entries()) {
      if (r === w) continue;
      const sizes = new Map<string, number>(
        (await reader.list(vault)).map((s) => [`${s.device}/${s.seg}`, s.size]),
      );
      for (const [k, bytes] of written) {
        const [dev, s] = k.split("/") as [DeviceId, string];
        const size = sizes.get(k) ?? 0;
        const read = [...(await reader.read(vault, dev, Number(s), 0))];
        if (size < bytes.length || read.length < bytes.length) {
          violations.push(
            `round ${round}: reader ${r} sees ${k} at ${Math.min(size, read.length)} of ${bytes.length} bytes ${bound} ms after the append`,
          );
        } else if (read.slice(0, bytes.length).join(",") !== bytes.join(",")) {
          violations.push(`round ${round}: reader ${r} reads other bytes for ${k}`);
        }
      }
    }
  }
  return { declared, claimed: true, ok: violations.length === 0, violations };
}
