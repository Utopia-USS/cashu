/** The renderer receives no filesystem path from the native connector picker. */
export interface ConnectorsBridge {
  installPending(): Promise<
    | { readonly kind: "cancelled" }
    | { readonly kind: "installed"; readonly id: string; readonly digest: string }
  >;
}

export function connectorsBridge(): ConnectorsBridge | null {
  return (
    (window as Window & { readonly cashuConnectors?: ConnectorsBridge }).cashuConnectors ?? null
  );
}
