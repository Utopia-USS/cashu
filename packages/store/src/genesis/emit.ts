// Envelope assembly of a genesis log (S26 spec 4 "validated with parseEvent", 5.2-5.4, 7; gid.md 7.1;
// events.md 2, 2.1, 7.10): every row's events are validated with `parseEvent` and the `detPartsOf`
// self-check before they get a clock (a row with a failing event is skipped whole, counted, and fails
// the run under `strict`), the base wall W comes from the kept rows' timestamps, and each event gets
// its (hlc, eid) from the genesis clock in log order. Output: wire envelopes (`toWire`) and their
// canonical JSON lines (`\n` terminated) with the sha256 of the bytes.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { canonicalJson } from "../canonical.js";
import { parseEvent } from "../events/v1/catalog.js";
import { detPartsOf } from "../events/v1/det-parts.js";
import { toWire, type WireEvent } from "../events/v1/envelope.js";
import { formatHlc } from "../events/v1/hlc-format.js";
import type { DetGid, VaultSalt } from "../gid.js";
import { GenesisClock, genesisDevice, genesisWall } from "./clock.js";
import { isJsonObject } from "./idFields.js";
import type { EventDraft, RowEvents } from "./map/context.js";
import { GenesisError } from "./report.js";

/** Spec 5.4: a genesis log is one logical batch, written / applied in chunks of this many events. */
export const GENESIS_CHUNK = 1000;

/** Top-level payload keys holding a timestamp (W reads them next to the stamps; gid.md 7.1). */
const PAYLOAD_TIMES = [
  "startedAt",
  "finishedAt",
  "createdAt",
  "doneAt",
  "seenAt",
  "observedAt",
  "lastCheckedAt",
  "lastTriggeredAt",
  "expiresAt",
  "snoozedUntil",
  "cooldownUntil",
  "until",
] as const;

interface EmitOptions {
  readonly vault: string;
  readonly salt: VaultSalt;
  readonly det: DetGid;
  readonly strict: boolean;
  /** The caller's clock: only the `clock_skew` guard reads it. */
  readonly now: number;
  count(table: string, reason: string): void;
}

interface VaultLog {
  readonly device: string;
  /** The base wall W (ms since the epoch). */
  readonly wall: number;
  /** Wire envelopes in (hlc, eid) order. */
  readonly events: readonly WireEvent[];
  /** Canonical JSON of each event, `\n` terminated: the jsonl log. */
  readonly lines: readonly string[];
  readonly logSha256: string;
  /** The rows whose events are in the log, in log order. */
  readonly rows: readonly RowEvents[];
}

type Check = "ok" | "invalid_event" | "det_mismatch";

/**
 * `parseEvent` (with `placeholder`'s envelope fields) and the `detPartsOf` self-check of one draft;
 * the S31a bridge validates its events with it too.
 */
function checkEvent(
  e: EventDraft,
  placeholder: Readonly<Record<string, unknown>>,
  det: DetGid,
): Check {
  const parsed = parseEvent({ ...placeholder, type: e.type, gid: e.gid, data: e.data });
  if (parsed.status !== "known") return "invalid_event";
  const parts = detPartsOf(e.type, e.data);
  return parts === undefined || det(parts.table, parts.parts) === e.gid ? "ok" : "det_mismatch";
}

/** `[name, value]` of every stamp and payload timestamp of the kept rows (W's input). */
function* timestampsOf(rows: readonly RowEvents[]): Generator<readonly [string, string | null]> {
  for (const row of rows) {
    for (const e of row.events) {
      const stamps = e.data.stamps;
      if (isJsonObject(stamps)) {
        for (const [name, value] of Object.entries(stamps)) {
          if (typeof value === "string") yield [name, value];
        }
      }
      for (const name of PAYLOAD_TIMES) {
        const value = e.data[name];
        if (typeof value === "string") yield [name, value];
      }
    }
  }
}

const utf8 = new TextEncoder();

/** The log of one vault from its rows (spec 5.1 order). */
export function emitVault(rows: readonly RowEvents[], opts: EmitOptions): VaultLog {
  const device = genesisDevice(opts.salt);
  // Everything parseEvent checks except the clock-derived fields (the data, the gid rules, the
  // vault); the real hlc / eid / at are assigned once the kept rows fix W.
  const placeholder = {
    eid: "00000000000000000000000000",
    vault: opts.vault,
    device,
    hlc: formatHlc({ wall: 0, counter: 0, device }),
    at: "1970-01-01T00:00:00Z",
    v: 1,
    origin: "genesis",
  };
  const kept = rows.filter((row) => {
    const failed = row.events
      .map((e) => checkEvent(e, placeholder, opts.det))
      .find((c) => c !== "ok");
    if (failed === undefined) return true;
    opts.count(row.table, failed);
    if (opts.strict) {
      throw new GenesisError("invalid_event", `an event of ${row.table} fails ${failed}`);
    }
    return false;
  });
  const wall = genesisWall(timestampsOf(kept), opts.now);
  const clock = new GenesisClock(opts.salt, wall);
  const events: WireEvent[] = [];
  const lines: string[] = [];
  const hash = sha256.create();
  for (const row of kept) {
    for (const e of row.events) {
      const { hlc, eid } = clock.next(e.type, e.gid);
      const wire = toWire({
        eid,
        vault: opts.vault,
        device,
        hlc,
        at: clock.at,
        type: e.type,
        v: 1,
        gid: e.gid,
        data: e.data,
        origin: "genesis",
      });
      const line = `${canonicalJson(wire)}\n`;
      hash.update(utf8.encode(line));
      events.push(wire);
      lines.push(line);
    }
  }
  return { device, wall, events, lines, logSha256: bytesToHex(hash.digest()), rows: kept };
}
