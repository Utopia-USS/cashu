// The Node adapter of the injectable HMAC (S29c spec 10, D11) for tests and benchmarks: node:crypto's
// native HMAC-SHA256. The production adapters live with the apps that construct a store (desktop and
// sync daemon: node:crypto; mobile: react-native-quick-crypto), wired in S40 / S41.
import { createHmac } from "node:crypto";
import type { HmacSha256 } from "../crypto/hmac.js";

export const nodeHmacSha256: HmacSha256 = {
  keyed(key) {
    const k = Uint8Array.from(key);
    return (message) => new Uint8Array(createHmac("sha256", k).update(message).digest());
  },
};
