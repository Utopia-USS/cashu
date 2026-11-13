// The S28a carrier contract and the propagation check over the Firestore relay transport against the
// Firestore + Auth emulators, with the security rules (/firestore.rules) enforced. Skipped unless the
// emulators run. Run with:
// JAVA_HOME=/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home PATH=/opt/homebrew/opt/openjdk/bin:$PATH firebase emulators:exec --only firestore,auth --project demo-cashu 'pnpm --filter @cashu/sync exec vitest run src/transports/firestore'
// (Java 21+; project id `demo-cashu` only, no login.) Synthetic ids and bytes only.
//
// Every medium is its own named database (independent of the rules suite, which clears the default
// one), the production root "vaults" (the rules match only it), and every device is its own anonymous
// user, made a member (bound to its device id) of the vault and of the suite's second, always empty
// vault by the rules-bypassing owner: the rules refuse a non-member, so "keeps vaults apart" lists an
// empty vault the device belongs to. The raw transport declares `linearizable`: the suite's propagation
// check (and the standalone one) is what allows that claim in production. The own-log carrier keeps
// the default `eventual` (as the folder carrier): it closes a segment once the next one exists, so the
// check's write pattern (growing segment 1 again after segment 2) is not its contract.
import { describe, expect, it } from "vitest";
import type { DeviceId, TransportConsistency, VaultId } from "../../carrier.js";
import { createOwnLogCarrier } from "../../carriers/ownlog/carrier.js";
import { createKeyring, createRecoveryKey, loadNodeSodium } from "../../crypto/index.js";
import { MemoryAuthStore } from "../../testing/firestore-fake.js";
import {
  CONTRACT_VAULT,
  checkPropagationClaim,
  describeCarrierContract,
  insecureTestCodec,
  insecureTestGate,
  testSigners,
} from "../../testing/index.js";
import { AnonymousAuth } from "./auth.js";
import {
  clearData,
  type EmulatorHosts,
  emulatorEndpoint,
  emulatorHosts,
  emulatorIdentity,
  ownerRest,
} from "./emulator.js";
import { FirestoreRest, str, ts } from "./rest.js";
import { FirestoreTransport } from "./transport.js";

const hosts = emulatorHosts();
const sodium = await loadNodeSodium();
const recovery = createRecoveryKey(sodium).publicKeys;
const LINEARIZABLE = { kind: "linearizable" } as const;
/** The contract suite's second vault (testing/contract.ts `OTHER_VAULT`), listed and expected empty. */
const OTHER_VAULT = "0badbeef0badbeef0badbeef0badbeef";

let media = 0;

/** A fresh database per medium: the emulator creates named databases on first use. */
function databaseName(): string {
  const hex = Math.floor(Math.random() * 0xffffffff).toString(16);
  return `t-${hex}-${++media}`;
}

interface RelayOptions {
  readonly claim?: TransportConsistency;
  /** The device whose member docs carry role `admin` (the Mac); every other device is a `member`. */
  readonly admin?: DeviceId;
}

/** Transports of one medium: one database, one anonymous member per device. */
function emulatorRelay(h: EmulatorHosts, vault: VaultId, options: RelayOptions = {}) {
  const database = databaseName();
  const endpoint = emulatorEndpoint(h, database);
  const owner = ownerRest(h, database);
  const members = new Map<DeviceId, Promise<AnonymousAuth>>();
  const member = (device: DeviceId): Promise<AnonymousAuth> => {
    let known = members.get(device);
    if (!known) {
      known = (async () => {
        const auth = new AnonymousAuth({
          endpoint: emulatorIdentity(h),
          store: new MemoryAuthStore(),
        });
        const uid = await auth.uid();
        const fields = {
          device: str(device),
          role: str(device === options.admin ? "admin" : "member"),
          addedAt: ts(new Date().toISOString()),
        };
        await owner.commit(
          [vault, OTHER_VAULT].map((v) => ({
            update: { name: `vaults/${v}/members/${uid}`, fields },
          })),
        );
        return auth;
      })();
      members.set(device, known);
    }
    return known;
  };
  const transportFor = async (device: DeviceId): Promise<FirestoreTransport> => {
    const auth = await member(device);
    return new FirestoreTransport({
      rest: new FirestoreRest({ endpoint, auth }),
      uid: () => auth.uid(),
      ...(options.claim ? { consistency: options.claim } : {}),
    });
  };
  const dispose = () => clearData(h, database);
  return { transportFor, owner, dispose };
}

/** Synthetic bytes that differ at every offset of a chunk (a misplaced chunk would not compare equal). */
function pattern(length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = (i * 31 + (i >>> 8) * 7) & 0xff;
  return out;
}

describe.skipIf(!hosts)("Firestore relay against the emulator", () => {
  const h = hosts as EmulatorHosts;

  it("passes the propagation check with a linearizable claim", async () => {
    const relay = emulatorRelay(h, CONTRACT_VAULT, { claim: LINEARIZABLE });
    try {
      const verdict = await checkPropagationClaim(
        { remoteFor: relay.transportFor },
        CONTRACT_VAULT,
      );
      expect(verdict.claimed).toBe(true);
      expect(verdict.violations).toEqual([]);
      expect(verdict.ok).toBe(true);
    } finally {
      await relay.dispose();
    }
  }, 60_000);

  // The default options under the rules: a 6 MiB append is one creating commit plus commits of at most
  // `maxChunksPerCommit` chunks and `maxCommitBytes` each, then the admin's purge (commits of up to 100
  // deletes, one rules check on its member doc each) removes segments and chunks, never the vault's
  // member documents.
  it("appends and reads back 6 MiB with the default options, then the admin purges it", async () => {
    const MAC = "ac".repeat(16);
    const PHONE = "bd".repeat(16);
    const relay = emulatorRelay(h, CONTRACT_VAULT, { admin: MAC });
    try {
      const phone = await relay.transportFor(PHONE);
      const data = pattern(6 * 1024 * 1024);
      await phone.append(CONTRACT_VAULT, PHONE, 0, 0, data);
      const tail = pattern(1000);
      await phone.append(CONTRACT_VAULT, PHONE, 0, data.length, tail);
      await phone.append(CONTRACT_VAULT, PHONE, 1, 0, tail);
      expect(await phone.list(CONTRACT_VAULT)).toEqual(
        expect.arrayContaining([
          { device: PHONE, seg: 0, size: data.length + tail.length },
          { device: PHONE, seg: 1, size: tail.length },
        ]),
      );
      const back = await phone.read(CONTRACT_VAULT, PHONE, 0, 0);
      expect(back.length).toBe(data.length + tail.length);
      expect(Buffer.from(back.subarray(0, data.length)).equals(Buffer.from(data))).toBe(true);
      expect(Buffer.from(back.subarray(data.length)).equals(Buffer.from(tail))).toBe(true);
      // A member may not purge; the admin may.
      await expect(phone.purge(CONTRACT_VAULT)).rejects.toMatchObject({ code: "unavailable" });
      const mac = await relay.transportFor(MAC);
      await mac.purge(CONTRACT_VAULT);
      expect(await mac.list(CONTRACT_VAULT)).toEqual([]);
      expect(await phone.list(CONTRACT_VAULT)).toEqual([]);
      const members = await relay.owner.runQuery(`vaults/${CONTRACT_VAULT}`, {
        collectionId: "members",
      });
      expect(members).toHaveLength(2);
    } finally {
      await relay.dispose();
    }
  }, 120_000);

  describeCarrierContract({
    name: "own log over the Firestore relay (emulator)",
    timeoutMs: 60_000,
    createMedium(vault) {
      const relay = emulatorRelay(h, vault);
      const signers = testSigners(sodium, createKeyring(sodium, recovery, vault));
      return {
        remoteFor: async (device) =>
          createOwnLogCarrier({
            transport: await relay.transportFor(device),
            codec: signers.codecFor(device),
            gate: signers.gateFor(device),
            device,
          }),
        codecFor: (device) => signers.codecFor(device),
        gateFor: (device) => signers.gateFor(device),
        dispose: relay.dispose,
      };
    },
  });

  describeCarrierContract({
    name: "raw Firestore relay transport (emulator)",
    timeoutMs: 60_000,
    createMedium(vault) {
      const relay = emulatorRelay(h, vault, { claim: LINEARIZABLE });
      const codec = insecureTestCodec();
      const gate = insecureTestGate();
      return {
        remoteFor: relay.transportFor,
        codecFor: () => codec,
        gateFor: () => gate,
        dispose: relay.dispose,
      };
    },
  });
});
