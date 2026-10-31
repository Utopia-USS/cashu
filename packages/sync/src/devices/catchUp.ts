// The catch-up requirement of the fetch lease (events.md 8.3 M6, S29c R3a): before newest-day
// imports a holder applies, for every device, the highest VALID cursor any lease event on the chain
// names. Valid, judged against what the registry proves today (no signed heads yet, R3b adds them):
// - the named device is registered (certified through some chain), else `unknown_device`;
// - a revoked device's entry is capped at its cut (the requirement expires with the revocation);
// - a registered device that is neither trusted nor revoked (conflicted) is `untrusted_device`: its
//   data is never accepted, so requiring it would block forever;
// - an owner waiver (`waive` on a claim or renewal) restarts a device's requirement at that event's
//   own entry for it (or removes it), for data the owner confirmed lost or withheld. A waiver counts
//   only with the owner's confirmation (events.ts `WaiveConfirmation`): typed on a trusted (not
//   revoked, not conflicted) writer, or signed by the recovery identity. Any other waiver is refused
//   (`waiversRefused`): a waived requirement re-allows newest-day duplicates.
// Entries of a writer revoked later count only when the lease event lies before its cut: the lease
// fold only walks events whose signature verifies with `registry.statementKeys`.

import type { SegmentCursor } from "../carrier.js";
import { accepted } from "./acceptance.js";
import { fromHex } from "./bytes.js";
import { type LeaseWaiver, type Watermark, waiveConfirmationText, waiverBody } from "./events.js";
import { beforeCut, comparePositions, minPosition } from "./positions.js";
import type { Registry } from "./registry.js";
import { type StatementVerifier, verifyStatement } from "./statements.js";
import { cmp } from "./util.js";

export type WatermarkDrop = "unknown_device" | "untrusted_device";

export interface DroppedWatermarkEntry {
  readonly device: string;
  readonly reason: WatermarkDrop;
  /** The lease event that named it. */
  readonly eid: string;
}

export type WaiverRefusal = "untrusted_writer" | "unconfirmed" | "bad_signature";

export interface RefusedWaiver {
  /** The lease event carrying the waiver (its watermark still counts). */
  readonly eid: string;
  readonly reason: WaiverRefusal;
}

export interface CatchUp {
  /** Per device, the cursor to apply first (validated, capped at a revoked device's cut). */
  readonly need: Watermark;
  /** Per device, the eid of the lease event that set the requirement (UI: who requires it). */
  readonly sources: ReadonlyMap<string, string>;
  readonly dropped: readonly DroppedWatermarkEntry[];
  readonly waiversRefused: readonly RefusedWaiver[];
}

/** Accumulates the requirement over the lease chain, in chain order. */
export class CatchUpFold {
  readonly #registry: Registry;
  readonly #need = new Map<string, SegmentCursor>();
  readonly #sources = new Map<string, string>();
  readonly #dropped: DroppedWatermarkEntry[] = [];
  readonly #refused: RefusedWaiver[] = [];
  readonly #verify: StatementVerifier;

  constructor(registry: Registry, verify: StatementVerifier = verifyStatement) {
    this.#registry = registry;
    this.#verify = verify;
  }

  /** One chain event of `writer`: its watermark and its waiver, if any. */
  add(eid: string, writer: string, watermark: Watermark, waiver?: LeaseWaiver): void {
    const waived = new Set(waiver && this.#confirmed(eid, writer, waiver) ? waiver.devices : []);
    for (const device of waived) {
      this.#need.delete(device);
      this.#sources.delete(device);
    }
    for (const [device, cursor] of Object.entries(watermark)) {
      const need = this.#valid(eid, device, cursor);
      if (!need) continue;
      const known = this.#need.get(device);
      if (known === undefined || comparePositions(need, known) > 0) {
        this.#need.set(device, need);
        this.#sources.set(device, eid);
      }
    }
  }

  result(): CatchUp {
    const need: Record<string, SegmentCursor> = {};
    for (const device of [...this.#need.keys()].sort(cmp)) {
      need[device] = this.#need.get(device) as SegmentCursor;
    }
    return {
      need,
      sources: new Map(this.#sources),
      dropped: [...this.#dropped],
      waiversRefused: [...this.#refused],
    };
  }

  #confirmed(eid: string, writer: string, waiver: LeaseWaiver): boolean {
    const registry = this.#registry;
    const c = waiver.confirmation;
    let reason: WaiverRefusal | undefined;
    if (c.kind === "recovery") {
      const body = waiverBody(registry.vaultId, eid, waiver.devices);
      const ok = accepted(this.#verify, "cashu/lease/v1", body, fromHex(c.sig), {
        kind: "recovery",
        signKeys: [registry.recovery.signPublicKey],
      });
      if (!ok) reason = "bad_signature";
    } else if (!registry.isTrusted(writer)) {
      reason = "untrusted_writer";
    } else if (c.text !== waiveConfirmationText(waiver.devices)) {
      reason = "unconfirmed";
    }
    if (reason) this.#refused.push({ eid, reason });
    return reason === undefined;
  }

  #valid(eid: string, device: string, cursor: SegmentCursor): SegmentCursor | undefined {
    const registry = this.#registry;
    if (!registry.isRegistered(device)) {
      this.#dropped.push({ device, reason: "unknown_device", eid });
      return undefined;
    }
    const revocation = registry.revoked.get(device);
    if (revocation) return minPosition(cursor, revocation.cut);
    if (!registry.isTrusted(device)) {
      this.#dropped.push({ device, reason: "untrusted_device", eid });
      return undefined;
    }
    return cursor;
  }
}

/** Devices whose streams are not applied up to `need` yet, with what is needed. */
export function behindNeed(
  need: Watermark,
  applied: ReadonlyMap<string, SegmentCursor>,
): { readonly device: string; readonly need: SegmentCursor }[] {
  const missing: { device: string; need: SegmentCursor }[] = [];
  for (const [device, cursor] of Object.entries(need)) {
    const have = applied.get(device);
    const behind =
      have === undefined
        ? comparePositions(cursor, { seg: 1, offset: 0 }) > 0
        : !beforeCut(cursor, have);
    if (behind) missing.push({ device, need: cursor });
  }
  return missing.sort((a, b) => cmp(a.device, b.device));
}
