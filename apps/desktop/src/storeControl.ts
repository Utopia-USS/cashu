// Control messages between the Electron main process and the store process (the utility process that
// runs the store engine). The renderer never sees these: it gets a MessagePort into the store process
// and speaks the store port protocol (@cashu/store-react/protocol) on it. No dependencies, so the
// tsc-built main process and the bundled store process share it.

/** main -> store process. A `connect` carries one transferred MessagePort for one renderer. */
export type ToStoreProcess = { readonly t: "connect" } | { readonly t: "stop" };

/** store process -> main. Lines are value-free (never rows, names or amounts). */
export type FromStoreProcess =
  | { readonly t: "ready"; readonly vaults: number }
  | { readonly t: "log"; readonly line: string }
  | { readonly t: "stopped" };

export function isToStoreProcess(value: unknown): value is ToStoreProcess {
  const t = (value as { t?: unknown } | null)?.t;
  return t === "connect" || t === "stop";
}

export function isFromStoreProcess(value: unknown): value is FromStoreProcess {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  switch (v.t) {
    case "ready":
      return typeof v.vaults === "number";
    case "log":
      return typeof v.line === "string";
    case "stopped":
      return true;
    default:
      return false;
  }
}

/** Command-line arguments of the store process. */
export interface StoreProcessArgs {
  /** The store's folder inside the data dir (device database, vault databases). */
  readonly storeDir: string;
  /** Seed and open a synthetic demo vault (dev flag only). */
  readonly demo: boolean;
}

export function storeProcessArgv(args: StoreProcessArgs): string[] {
  return ["--store-dir", args.storeDir, ...(args.demo ? ["--demo"] : [])];
}

export function parseStoreProcessArgv(argv: readonly string[]): StoreProcessArgs | null {
  const i = argv.indexOf("--store-dir");
  const storeDir = i >= 0 ? argv[i + 1] : undefined;
  if (storeDir === undefined || storeDir === "" || storeDir.startsWith("--")) return null;
  return { storeDir, demo: argv.includes("--demo") };
}
