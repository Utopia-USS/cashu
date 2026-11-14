// The in-memory carrier: one shared `MemoryTransport` as the remote of every device (a perfect,
// instant relay) and the insecure test codec. The reference that defines "passes the contract".

import { insecureTestCodec, insecureTestGate } from "./codec.js";
import type { CarrierUnderTest } from "./contract.js";
import { MemoryTransport } from "./memory.js";

export const memoryCarrier: CarrierUnderTest = {
  name: "memory",
  createMedium() {
    const shared = new MemoryTransport();
    const codec = insecureTestCodec();
    const gate = insecureTestGate();
    return { remoteFor: () => shared, codecFor: () => codec, gateFor: () => gate };
  },
};
