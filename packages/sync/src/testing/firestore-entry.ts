// `@cashu/sync/testing/firestore`: the fake Firebase (Identity Toolkit + Firestore REST over an injected
// `fetch`), its memory auth store and the memory transport, for tests outside vitest (the phone's Jest
// suite). Imports no vitest, unlike the `@cashu/sync/testing` barrel with the carrier contract suite.
// Test code only; never import it from runtime code.
export {
  createFakeFirebase,
  type FakeFaults,
  type FakeFirebase,
  type FakeFirebaseOptions,
  MemoryAuthStore,
} from "./firestore-fake.js";
export { MemoryClockStore, MemoryTransport } from "./memory.js";
