// The S28a carrier contract over the Firestore relay transport, against the in-memory fake Firebase
// (`createFakeFirebase`): every `createMedium` call is a fresh fake with its own random collection
// prefix, and every device is its own anonymous user (its own uid) over that shared fake.
//
// Two carriers: the production wiring (own-log carrier with real S27 signers over the transport, as
// folder.contract.test.ts) and the raw transport with the insecure test codec (the raw-transport
// scenarios, as memory.contract.test.ts), the latter declaring `linearizable` so the propagation check
// runs against the fake (one in-memory database: every read sees every committed write).
// The same suite against the emulator: firestore.emulator.contract.test.ts.
import type { DeviceId, TransportConsistency } from "../../carrier.js";
import { createOwnLogCarrier } from "../../carriers/ownlog/carrier.js";
import { createKeyring, createRecoveryKey, loadNodeSodium } from "../../crypto/index.js";
import {
  createFakeFirebase,
  type FakeFirebase,
  MemoryAuthStore,
} from "../../testing/firestore-fake.js";
import {
  describeCarrierContract,
  insecureTestCodec,
  insecureTestGate,
  testSigners,
} from "../../testing/index.js";
import { AnonymousAuth } from "./auth.js";
import { FirestoreRest } from "./rest.js";
import { FirestoreTransport } from "./transport.js";

const sodium = await loadNodeSodium();
const recovery = createRecoveryKey(sodium).publicKeys;

let media = 0;

function randomRoot(): string {
  const hex = Math.floor(Math.random() * 0xffffffff).toString(16);
  return `t_${hex}_${++media}`;
}

/** One transport per call, one anonymous identity per device (stable across calls). */
function relay(fake: FakeFirebase, consistency?: TransportConsistency) {
  const root = randomRoot();
  const auths = new Map<DeviceId, AnonymousAuth>();
  return (device: DeviceId): FirestoreTransport => {
    let auth = auths.get(device);
    if (!auth) {
      auth = new AnonymousAuth({
        endpoint: fake.identity,
        store: new MemoryAuthStore(),
        fetch: fake.fetch,
      });
      auths.set(device, auth);
    }
    const rest = new FirestoreRest({
      endpoint: fake.endpoint,
      auth,
      fetch: fake.fetch,
      sleep: async () => {},
    });
    const uid = auth;
    return new FirestoreTransport({
      rest,
      uid: () => uid.uid(),
      root,
      ...(consistency ? { consistency } : {}),
    });
  };
}

describeCarrierContract({
  name: "own log over the Firestore relay (in-memory fake)",
  async createMedium(vault) {
    const transportFor = relay(createFakeFirebase());
    const signers = testSigners(sodium, createKeyring(sodium, recovery, vault));
    return {
      remoteFor: (device) =>
        createOwnLogCarrier({
          transport: transportFor(device),
          codec: signers.codecFor(device),
          gate: signers.gateFor(device),
          device,
        }),
      codecFor: (device) => signers.codecFor(device),
      gateFor: (device) => signers.gateFor(device),
    };
  },
});

describeCarrierContract({
  name: "raw Firestore relay transport (in-memory fake, linearizable claim)",
  createMedium() {
    const transportFor = relay(createFakeFirebase(), { kind: "linearizable" });
    const codec = insecureTestCodec();
    const gate = insecureTestGate();
    return { remoteFor: transportFor, codecFor: () => codec, gateFor: () => gate };
  },
});
