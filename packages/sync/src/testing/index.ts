// Test kit for carrier adapters and store tests (`@cashu/sync/testing`). Imports vitest: never import
// it from runtime code.
export { InMemoryKeyStore, keyringFromKeys } from "../crypto/testing.js";
export { insecureTestCodec, insecureTestGate } from "./codec.js";
export {
  type CarrierMedium,
  type CarrierUnderTest,
  CONTRACT_VAULT,
  describeCarrierContract,
} from "./contract.js";
export { FaultInjector, ManualClock } from "./faults.js";
export { memoryCarrier } from "./memory-carrier.js";
export {
  checkPropagationClaim,
  type PropagationMedium,
  type PropagationVerdict,
} from "./propagation.js";
export { SimulatedRelay, type SimulatedRelayOptions } from "./relay-sim.js";
export { type TestSigners, testSigners } from "./signers.js";
export { type Delivery, MemorySink } from "./sink.js";
