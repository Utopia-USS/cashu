// Which session frames each role may send. The host closes a session that sends anything else (an
// unknown method of an allowed namespace is answered `unknown-method` by the host's dispatcher).

import { NATIVE_DEVICES_METHODS } from "./devices/messages.js";
import type { ClientFrame, Role } from "./messages.js";
import { NOTIFICATION_INTENT_METHOD } from "./notificationIntent.js";
import { NATIVE_PAIRING_METHODS } from "./pairing/messages.js";

const NAMESPACE: Readonly<Record<Role, string | undefined>> = {
  ui: undefined,
  mcp: "mcp.",
  cli: "cli.",
  admin: "admin.",
};

export const NATIVE_CREATION_FEATURE = "native.creation.v1";
export const NATIVE_CREATION_METHODS = [
  "native.creation.prepare",
  "native.creation.commit",
  "native.creation.inspect",
  "native.creation.current",
] as const;
export const NATIVE_CONNECTORS_FEATURE = "native.connectors.v1";
export const NATIVE_CONNECTORS_METHODS = [
  "native.connectors.prepareInstall",
  "native.connectors.commitInstall",
] as const;

export function uiCreationAllowed(
  method: string,
  protocolMinor: number,
  features: readonly string[],
): boolean {
  return (
    protocolMinor >= 3 &&
    features.includes(NATIVE_CREATION_FEATURE) &&
    NATIVE_CREATION_METHODS.some((allowed) => method === allowed)
  );
}

/** True when a session of `role` may send `frame`. */
export function roleAllows(role: Role, frame: ClientFrame): boolean {
  switch (frame.t) {
    case "store":
      return role === "ui";
    case "mcp":
      return role === "mcp";
    case "req": {
      if (role === "ui")
        return (
          frame.method === NOTIFICATION_INTENT_METHOD ||
          NATIVE_CREATION_METHODS.some((method) => frame.method === method) ||
          NATIVE_CONNECTORS_METHODS.some((method) => frame.method === method) ||
          NATIVE_PAIRING_METHODS.some((method) => frame.method === method) ||
          NATIVE_DEVICES_METHODS.some((method) => frame.method === method)
        );
      const prefix = NAMESPACE[role];
      return prefix !== undefined && frame.method.startsWith(prefix);
    }
    case "cancel":
      return NAMESPACE[role] !== undefined;
  }
}
