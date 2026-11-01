// TRANSITIONAL(S56): the lab / dev host's frame gate (S29c phase B2, B3). The host process (S56)
// owns the device trust state and replaces it with the registry's `DeviceFrameGate`.
//
// The lab host runs without the device registry (no pairing, S31a deviation: rings come from the lab
// key store), so it cannot use `DeviceFrameGate`. Every device of a lab vault is instead certified by
// the vault's recovery identity when it is created (the creator, the genesis device, each harness
// device), and the certificates are kept in the lab key store (`labCertificates`). This gate accepts
// a frame only when its head verifies under the key such a certificate gives its writer; any other
// writer waits.
//
// Retirement (S29c-B3): a device's self-revocation (`device.revoked` naming its own writer, in a frame
// that writer signed: the genesis device retires itself after the genesis stream) retires it at the
// statement's own position, as the registry's fold does: any later frame of that stream is verified
// but its data is rejected (`revoked_writer`). Revocations of other devices do not exist in the lab
// and are ignored. Because it keeps that statement state, the gate replays the log after a start,
// from its snapshot (signed by this device, `cashu/state/v1`) when the engine restored one.
import { crypto, devices, type FrameGate, type FrameHead } from "@cashu/sync";
import { labCertificates } from "./vaultKeys.js";

type Cursor = { readonly seg: number; readonly offset: number };

const after = (a: Cursor, b: Cursor) => a.seg > b.seg || (a.seg === b.seg && a.offset > b.offset);
const STATE = "cashu/state/v1";
const utf8 = new TextEncoder();

function signedBody(vaultId: string, device: string, json: string): Uint8Array {
  const parts = [vaultId, device, json].map((t) => utf8.encode(t));
  const out = new Uint8Array(parts.reduce((n, p) => n + 4 + p.length, 0));
  const view = new DataView(out.buffer);
  let at = 0;
  for (const p of parts) {
    view.setUint32(at, p.length);
    out.set(p, at + 4);
    at += 4 + p.length;
  }
  return out;
}

const isCursor = (v: unknown): v is [string, number, number] =>
  Array.isArray(v) &&
  typeof v[0] === "string" &&
  Number.isSafeInteger(v[1]) &&
  Number.isSafeInteger(v[2]);

/** The gate of one lab vault: the certificates the key store holds when the vault is opened. */
export async function labGate(
  store: crypto.KeyStore,
  sodium: crypto.Sodium,
  ring: crypto.Keyring,
  identity: crypto.DeviceIdentity,
): Promise<FrameGate> {
  const check = crypto.verifyCertificates(
    sodium,
    ring.vaultId,
    ring.recovery.signPublicKey,
    await labCertificates(store, ring.vaultId),
    new Set(),
  );
  const keys = new Map([...check.devices].map(([id, d]) => [id, d.signPublicKey.slice()]));
  /** Self-retired devices and the position of their retirement. */
  const retired = new Map<string, Cursor>();
  /** Per writer, the end of the data accepted (to notice a retirement below it: rebuild). */
  const applied = new Map<string, Cursor>();
  let rebuild = false;

  const signed = (head: FrameHead) => {
    const key = keys.get(head.device);
    return key !== undefined && crypto.verifyHeadSignature(ring.vaultId, head, key);
  };
  const observe = (head: FrameHead, events: readonly { t: string; v: number; d: object }[]) => {
    for (const e of events) {
      if (e.t !== devices.DEVICE_REVOKED || e.v !== 1) continue;
      const data = devices.decodeDeviceRevoked(e.d as Record<string, unknown>);
      if (data?.signer !== head.device) continue;
      if (!data.devices.some((d) => d.device === head.device)) continue;
      const at = { seg: head.seg, offset: head.offset };
      const known = retired.get(head.device);
      if (known && !after(known, at)) continue;
      retired.set(head.device, at);
      const done = applied.get(head.device);
      if (done && after(done, at)) rebuild = true;
    }
  };

  return {
    authenticate(head) {
      if (!keys.has(head.device)) return { ok: false, wait: true, code: "writer-unknown" };
      return signed(head) ? { ok: true } : { ok: false, wait: false, code: "bad_head_signature" };
    },
    accept(head, events) {
      observe(head, events);
      const cut = retired.get(head.device);
      const end = { seg: head.seg, offset: head.offset };
      if (cut && after(end, cut)) {
        return { verdict: { ok: false, wait: false, code: "revoked_writer" }, changed: false };
      }
      const known = applied.get(head.device);
      if (!known || after(end, known)) applied.set(head.device, end);
      return { verdict: { ok: true }, changed: false };
    },
    observe,
    needsReplay: () => true,
    takeRebuild() {
      const r = rebuild;
      rebuild = false;
      return r;
    },
    reset() {
      applied.clear();
      rebuild = false;
    },
    exportState(positions) {
      const json = JSON.stringify({
        v: 1,
        positions: [...positions.values()].map(crypto.encodeHead),
        retired: [...retired].map(([d, at]) => [d, at.seg, at.offset]),
        applied: [...applied].map(([d, at]) => [d, at.seg, at.offset]),
      });
      try {
        const sig = identity.sign(STATE, signedBody(ring.vaultId, identity.deviceId, json));
        return `${json}\n${Buffer.from(sig).toString("hex")}`;
      } catch {
        return undefined;
      }
    },
    importState(state) {
      const cut = state.lastIndexOf("\n");
      if (cut < 0 || !/^[0-9a-f]{128}$/.test(state.slice(cut + 1))) return undefined;
      const sig = Buffer.from(state.slice(cut + 1), "hex");
      const json = state.slice(0, cut);
      const body = signedBody(ring.vaultId, identity.deviceId, json);
      if (!crypto.verifyContextSignature(STATE, body, sig, identity.signPublicKey))
        return undefined;
      let raw: { v?: unknown; positions?: unknown; retired?: unknown; applied?: unknown };
      try {
        raw = JSON.parse(json) as typeof raw;
      } catch {
        return undefined;
      }
      if (raw.v !== 1 || !Array.isArray(raw.positions)) return undefined;
      if (!Array.isArray(raw.retired) || !raw.retired.every(isCursor)) return undefined;
      if (!Array.isArray(raw.applied) || !raw.applied.every(isCursor)) return undefined;
      const heads = raw.positions.map((p) => crypto.decodeHead(p));
      const positions = new Map<string, FrameHead>();
      for (const head of heads) {
        if (head?.stream !== 1 || !signed(head)) return undefined;
        positions.set(head.device, head);
      }
      const savedRetired = raw.retired;
      const savedApplied = raw.applied;
      return {
        positions,
        restore() {
          for (const [d, seg, offset] of savedRetired) retired.set(d, { seg, offset });
          for (const [d, seg, offset] of savedApplied) applied.set(d, { seg, offset });
          rebuild = false;
        },
      };
    },
  };
}
