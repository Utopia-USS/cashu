import {
  type ConnectorSecretAuthority,
  type ConnectorSecretIdentity,
  type ConnectorSecretVault,
  createProductionConnectorSecretCleanup,
  createProductionConnectorSecretVault,
} from "@cashu/node-host/connector-secrets";
import type { ConnectorBinding, ConnectorSecretStore } from "./binding.js";
import type { ConnectorCatalog } from "./catalog.js";
import { ConnectorFault } from "./manifest.js";

export interface BoundConnectorSecrets extends ConnectorSecretStore {
  set(secretId: string, value: string): Promise<void>;
  clear(secretId: string): Promise<void>;
}

/** The host constructs this only from the approved installed manifest and authenticated binding. */
export function boundConnectorSecrets(input: {
  readonly catalog: ConnectorCatalog;
  readonly binding: ConnectorBinding;
  readonly interpreter: string;
  readonly authority: ConnectorSecretAuthority;
  /** Synthetic tests only. Production uses the separate OS Keyring service. */
  readonly makeVault?: (
    authority: ConnectorSecretAuthority,
    identity: ConnectorSecretIdentity,
  ) => ConnectorSecretVault;
}): BoundConnectorSecrets {
  const loaded = input.catalog.approved(input.binding.connectorId, input.interpreter);
  if (
    loaded.manifest.kind !== "fetch" ||
    loaded.manifest.module !== input.binding.module ||
    !input.binding.enabled
  )
    throw new ConnectorFault("invalid_manifest", "binding does not match approved connector");
  const identity: ConnectorSecretIdentity = {
    profileId: input.binding.profileId,
    bindingId: input.binding.id,
    connectorId: input.binding.connectorId,
    secretIds: Object.freeze(loaded.manifest.fetch?.secrets.map((spec) => spec.id) ?? []),
  };
  const vault = (input.makeVault ?? createProductionConnectorSecretVault)(
    input.authority,
    identity,
  );
  const check = (profileId: string, bindingId: string, secretId: string): void => {
    let current = false;
    try {
      current =
        input.authority.isCurrent(identity) &&
        input.catalog.approved(input.binding.connectorId, input.interpreter).contentSha256 ===
          loaded.contentSha256;
    } catch {
      current = false;
    }
    if (
      profileId !== identity.profileId ||
      bindingId !== identity.bindingId ||
      !identity.secretIds.includes(secretId) ||
      !current
    )
      throw new ConnectorFault("changed", "binding secret authority unavailable");
  };
  return {
    async get(profileId, bindingId, secretId) {
      check(profileId, bindingId, secretId);
      return vault.get(secretId);
    },
    async set(secretId, value) {
      check(identity.profileId, identity.bindingId, secretId);
      return vault.set(secretId, value);
    },
    async clear(secretId) {
      check(identity.profileId, identity.bindingId, secretId);
      return vault.clear(secretId);
    },
  };
}

/** Deletion-only owner capability; installed code is inspected but never approved or executed. */
export function deletionOnlyConnectorSecrets(input: {
  readonly catalog: ConnectorCatalog;
  readonly binding: ConnectorBinding;
  readonly authority: ConnectorSecretAuthority;
  readonly makeCleanup?: (
    authority: ConnectorSecretAuthority,
    identity: ConnectorSecretIdentity,
  ) => Pick<ConnectorSecretVault, "clear">;
}): Pick<ConnectorSecretVault, "clear"> & { readonly secretIds: readonly string[] } {
  const loaded = input.catalog.installed(input.binding.connectorId);
  if (loaded.manifest.kind !== "fetch" || loaded.manifest.module !== input.binding.module)
    throw new ConnectorFault("invalid_manifest", "binding does not match installed connector");
  const identity: ConnectorSecretIdentity = {
    profileId: input.binding.profileId,
    bindingId: input.binding.id,
    connectorId: input.binding.connectorId,
    secretIds: Object.freeze(loaded.manifest.fetch?.secrets.map((spec) => spec.id) ?? []),
  };
  const cleanup = (input.makeCleanup ?? createProductionConnectorSecretCleanup)(
    input.authority,
    identity,
  );
  return {
    secretIds: identity.secretIds,
    async clear(secretId) {
      if (
        !input.authority.isOwnerAction() ||
        !input.authority.isCurrent(identity) ||
        !identity.secretIds.includes(secretId)
      )
        throw new ConnectorFault("changed", "binding cleanup authority unavailable");
      await cleanup.clear(secretId);
    },
  };
}
