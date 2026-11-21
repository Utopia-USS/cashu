/** The served Ustawienia > Konektory list: the installed connectors of the host's catalog bound into the live
 * `connectorSettingsSnapshot` query, re-run when the catalog changes (no renderer re-read). */

import {
  type ConnectorCatalogSource,
  type ConnectorSettingsSnapshot,
  connectorSettingsQuery,
} from "@cashu/store/core/desktop-settings";
import type { ChangeSource } from "@cashu/store/query";
import type { ConnectorCatalog } from "./connectors/catalog.js";

type Connector = ConnectorSettingsSnapshot["connectors"][number];

/** Every installed connector with the manifest facts the old drawer showed (ab24ab6 `detail_dict`). */
export function connectorInventory(catalog: ConnectorCatalog): Connector[] {
  return catalog.list().map((item) => {
    try {
      const { manifest } = catalog.installed(item.id);
      return {
        ...item,
        params: manifest.fetch?.params ?? [],
        secrets: manifest.fetch?.secrets ?? [],
        version: manifest.version,
        author: manifest.author ?? null,
        description: manifest.description ?? null,
        run: manifest.run,
        timeoutS: manifest.timeout_s,
        hosts: manifest.fetch?.hosts ?? [],
        extensions: manifest.file?.extensions ?? [],
        historyDays: manifest.fetch?.history_days ?? null,
      };
    } catch {
      // A changed item remains visible by its catalog status, without manifest facts.
      return { ...item, params: [], secrets: [] };
    }
  });
}

/**
 * `catalog()` is the host's catalog (bound once at host start, before any UI session subscribes, so `changes` can
 * follow it from the subscription on); `shows(vault)` says whether the owner of that open vault may see it (a native
 * vault). Otherwise the list is null (unavailable), as the old action answered.
 */
export function connectorSettingsServed(deps: {
  catalog(): ConnectorCatalog | undefined;
  shows(vault: string): boolean;
}) {
  const changes: ChangeSource = {
    subscribe: (listener) => deps.catalog()?.changes.subscribe(listener) ?? (() => {}),
  };
  const source: ConnectorCatalogSource = {
    changes,
    connectors(vault) {
      const catalog = deps.shows(vault) ? deps.catalog() : undefined;
      if (catalog === undefined) return null;
      try {
        return connectorInventory(catalog);
      } catch {
        // An unreadable catalog directory (changed pin, over the limit) shows the section as unavailable.
        return null;
      }
    },
  };
  return connectorSettingsQuery(source);
}
