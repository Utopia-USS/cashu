// Device identity: every device has an X25519 key pair (key wraps are sealed for it) and an Ed25519
// signing key (it signs the wraps it sends, so a recipient knows which registered device sent them).
// Public keys are always computed from the secret halves (@noble/curves, the same code on every
// runtime), never stored or accepted next to them, so a public key cannot disagree with its secret.

import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { concat, toHex, utf8 } from "./encoding.js";
import { CryptoError } from "./errors.js";
import { Secret } from "./secret.js";
import { KEY_BYTES, type Sodium } from "./sodium.js";

export const DEVICE_ID_BYTES = 16;
export const SIGNATURE_BYTES = 64;
const DEVICE_ID = /^[0-9a-f]{32}$/;
const INSPECT = Symbol.for("nodejs.util.inspect.custom");

/**
 * Every purpose a device or recovery key signs for. No context is a prefix of another (they differ by
 * byte 6 at the latest), so a signature made for one purpose never verifies for another:
 * - `cashu/wrap/v3`: signed key wraps (wrap.ts); `cashu/cert/v1`: device certificates (cert.ts);
 * - `cashu/registry/v1`: device registry statements (`device.added`, `device.revoked`,
 *   `device.recoveryChanged`); `cashu/lease/v1`: fetch-lease statements; `cashu/pairing/v1`: pairing
 *   messages (challenge, welcome). Bodies are built by `devices/` from length-prefixed fields and
 *   canonical JSON; `cashu/head/v1`: signed stream heads, one per frame (head.ts, S29c phase B2).
 */
export type SigningContext =
  | "cashu/wrap/v3"
  | "cashu/cert/v1"
  | "cashu/registry/v1"
  | "cashu/lease/v1"
  | "cashu/pairing/v1"
  | "cashu/head/v1";

const SIGNING_CONTEXTS: ReadonlySet<string> = new Set<SigningContext>([
  "cashu/wrap/v3",
  "cashu/cert/v1",
  "cashu/registry/v1",
  "cashu/lease/v1",
  "cashu/pairing/v1",
  "cashu/head/v1",
]);

/** Reserved signer id of the recovery identity (16 zero bytes); never a device's id. */
export const RECOVERY_SIGNER_ID = "0".repeat(DEVICE_ID_BYTES * 2);

/** A device id: 16 random bytes as 32 lowercase hex characters, fresh per install. */
export function createDeviceId(sodium: Sodium): string {
  for (;;) {
    const id = toHex(sodium.randomBytes(DEVICE_ID_BYTES));
    if (id !== RECOVERY_SIGNER_ID) return id;
  }
}

export function isDeviceId(deviceId: string): boolean {
  return DEVICE_ID.test(deviceId) && deviceId !== RECOVERY_SIGNER_ID;
}

export function assertDeviceId(deviceId: string): void {
  if (!isDeviceId(deviceId)) {
    throw new RangeError("device id must be 32 lowercase hex characters, not all zero");
  }
}

/** The public half of a recovery identity: pinned in every keyring of the vault (key payload v3). */
export interface RecoveryPublicKeys {
  readonly boxPublicKey: Uint8Array;
  readonly signPublicKey: Uint8Array;
}

/** Where a wrap is sealed to: a device id (or `RECOVERY_SIGNER_ID`) and its X25519 public key. */
export interface WrapRecipient {
  readonly deviceId: string;
  readonly boxPublicKey: Uint8Array;
}

function checkSecretLength(secret: Secret): void {
  if (secret.length !== KEY_BYTES) throw new RangeError("secret key must be 32 bytes");
}

/** An X25519 key pair; the public key is derived from the secret key. */
export class BoxKeyPair {
  readonly publicKey: Uint8Array;
  readonly secretKey: Secret;

  constructor(secretKey: Secret) {
    checkSecretLength(secretKey);
    this.secretKey = secretKey;
    this.publicKey = x25519.getPublicKey(secretKey.expose());
  }

  wipe(): void {
    this.secretKey.wipe();
  }

  toJSON(): { publicKey: string } {
    return { publicKey: "[public]" };
  }

  [INSPECT](): string {
    return "BoxKeyPair([redacted])";
  }
}

/** Box key pair + Ed25519 signing key (32-byte seed) under one signer id. */
class SigningIdentity {
  readonly deviceId: string;
  readonly box: BoxKeyPair;
  readonly signPublicKey: Uint8Array;
  readonly signSecretKey: Secret;

  protected constructor(deviceId: string, boxSecretKey: Secret, signSeed: Secret) {
    checkSecretLength(signSeed);
    this.deviceId = deviceId;
    this.box = new BoxKeyPair(boxSecretKey);
    this.signSecretKey = signSeed;
    this.signPublicKey = ed25519.getPublicKey(signSeed.expose());
  }

  /** Where wraps for this identity are sealed to. */
  get recipient(): WrapRecipient {
    return { deviceId: this.deviceId, boxPublicKey: this.box.publicKey };
  }

  /**
   * Signs `context | body`. Only the fixed contexts below exist, so this key never signs raw caller
   * bytes and a signature made for one purpose never verifies for another.
   */
  sign(context: SigningContext, body: Uint8Array): Uint8Array {
    if (!SIGNING_CONTEXTS.has(context)) throw new RangeError("unknown signing context");
    return ed25519.sign(concat(utf8(context), body), this.signSecretKey.expose());
  }

  wipe(): void {
    this.box.wipe();
    this.signSecretKey.wipe();
  }

  toJSON(): { deviceId: string; keys: string } {
    return { deviceId: this.deviceId, keys: "[redacted]" };
  }

  [INSPECT](): string {
    return `${this.constructor.name}(${this.deviceId}, [redacted])`;
  }
}

export class DeviceIdentity extends SigningIdentity {
  /** Takes ownership of both secrets; public keys are recomputed from them. */
  constructor(deviceId: string, boxSecretKey: Secret, signSeed: Secret) {
    assertDeviceId(deviceId);
    super(deviceId, boxSecretKey, signSeed);
  }
}

/** The identity derived from the 24 recovery words (recovery.ts); signs as `RECOVERY_SIGNER_ID`. */
export class RecoveryIdentity extends SigningIdentity {
  constructor(boxSecretKey: Secret, signSeed: Secret) {
    super(RECOVERY_SIGNER_ID, boxSecretKey, signSeed);
  }

  get publicKeys(): RecoveryPublicKeys {
    return { boxPublicKey: this.box.publicKey, signPublicKey: this.signPublicKey };
  }
}

export function createDeviceIdentity(
  sodium: Sodium,
  deviceId: string = createDeviceId(sodium),
): DeviceIdentity {
  return new DeviceIdentity(
    deviceId,
    new Secret(sodium.randomBytes(KEY_BYTES)),
    new Secret(sodium.randomBytes(KEY_BYTES)),
  );
}

/**
 * Verifies a signature made with `sign(context, body)`: `context | body` under `publicKey`. The
 * caller names the context, so a signature for one purpose never verifies for another.
 */
export function verifyContextSignature(
  context: SigningContext,
  body: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array,
): boolean {
  if (!SIGNING_CONTEXTS.has(context)) throw new RangeError("unknown signing context");
  return verifySignature(signature, concat(utf8(context), body), publicKey);
}

/**
 * Ed25519 verification (ZIP-215 off: strict RFC 8032). Wrong lengths and every malformed or forged
 * signature are simply invalid (@noble returns false for them); an exception from the library is a
 * runtime problem, reported as `unsupported_runtime`, never as an authentication failure.
 */
export function verifySignature(
  signature: Uint8Array,
  message: Uint8Array,
  publicKey: Uint8Array,
): boolean {
  if (signature.length !== SIGNATURE_BYTES || publicKey.length !== 32) return false;
  try {
    return ed25519.verify(signature, message, publicKey, { zip215: false });
  } catch {
    throw new CryptoError("unsupported_runtime");
  }
}
