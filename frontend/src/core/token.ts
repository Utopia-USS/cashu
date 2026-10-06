// Per-launch API token bootstrap (PK1). The server never puts the token into the page (any local
// process can GET /), so the SPA gets it out of band, in this order:
//
// 1. the `#token=<token>` fragment of the one-time URL `cashu serve` prints (browsers never send
//    the fragment to the server): moved to sessionStorage (this tab only) and stripped from the
//    address bar with history.replaceState, before the hash router reads the location;
// 2. sessionStorage: a reload in the same tab keeps working;
// 3. `<meta name="cashu-token">`: only with CASHU_DEV_EMBED_TOKEN=1 (explicit dev mode);
// 4. the desktop window: `window.pywebview.api.token()` (cashU app, desktop/shell.py), which
//    pywebview injects after the page has loaded, so the SPA waits for it (short timeout).
//
// Under `npm run dev` there is no token in the page: the Vite proxy adds the header itself.
import { readStored } from "./storage.ts";

export const TOKEN_STORAGE_KEY = "cashu.apiToken";
export const TOKEN_FRAGMENT = "token";
export const DESKTOP_TIMEOUT_MS = 5000;
export const NO_TOKEN_TEXT =
  "Brak tokenu dostępu. Otwórz aplikację cashU albo adres z #token=..., który wypisuje `cashu serve`.";

interface LocationLike { hash: string; pathname: string; search: string }
interface HistoryLike { state: unknown; replaceState(data: unknown, unused: string, url?: string): void }
type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** The token in a `#token=<token>` fragment (other `&`-separated parts are ignored), else null. */
export function fragmentToken(hash: string): string | null {
  const body = hash.startsWith("#") ? hash.slice(1) : hash;
  for (const part of body.split("&")) {
    const [key, ...rest] = part.split("=");
    if (key === TOKEN_FRAGMENT && rest.length) {
      let value = rest.join("=");
      try { value = decodeURIComponent(value); } catch { /* keep the raw value */ }
      return value || null;
    }
  }
  return null;
}

/** Step 1: a fragment token goes to `storage` and leaves the address bar (and the history entry).
 * Returns it, else null. Never throws (storage may be unavailable). */
export function captureFragmentToken(loc: LocationLike, history: HistoryLike, storage: StorageLike | null): string | null {
  const token = fragmentToken(loc.hash);
  if (!token) return null;
  try { storage?.setItem(TOKEN_STORAGE_KEY, token); } catch { /* private mode: memory only */ }
  try { history.replaceState(history.state, "", loc.pathname + loc.search); } catch { /* ignore */ }
  return token;
}

export function storedToken(storage: StorageLike | null): string | null {
  try { return readStored(storage, TOKEN_STORAGE_KEY) || null; } catch { return null; }
}

interface DesktopBridge { api?: { token?: () => Promise<string | null> } }
interface TokenWindow {
  pywebview?: DesktopBridge;
  addEventListener(type: string, cb: () => void): void;
  removeEventListener(type: string, cb: () => void): void;
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

/** Step 4: ask the desktop bridge, waiting for pywebview to inject it (`pywebviewready`), at most
 * `timeoutMs`. Resolves null outside the desktop window or when the bridge refuses. */
export function desktopToken(win: TokenWindow, timeoutMs = DESKTOP_TIMEOUT_MS): Promise<string | null> {
  const ask = async (): Promise<string | null> => {
    try { return (await win.pywebview!.api!.token!()) || null; } catch { return null; }
  };
  if (win.pywebview?.api?.token) return ask();
  return new Promise((resolve) => {
    const done = () => {
      win.clearTimeout(timer);
      win.removeEventListener("pywebviewready", done);
      if (win.pywebview?.api?.token) void ask().then(resolve);
      else resolve(null);
    };
    const timer = win.setTimeout(done, timeoutMs);
    win.addEventListener("pywebviewready", done);
  });
}

/** A shared lookup that caches only a found value (F7 fix pass R2): concurrent callers share the request in
 * flight, but a null result (the desktop bridge was not ready within the timeout) is not kept, so the next
 * request asks again. `reset()` drops a cached value (a 401). */
export function cacheFound<T>(lookup: () => Promise<T | null>): { get(): Promise<T | null>; reset(): void } {
  let pending: Promise<T | null> | null = null;
  return {
    get() {
      if (!pending) {
        const p = lookup().then((v) => {
          if (v == null && pending === p) pending = null;
          return v;
        }, () => {
          if (pending === p) pending = null;
          return null;
        });
        pending = p;
      }
      return pending;
    },
    reset() { pending = null; },
  };
}

// ---- the page's token -------------------------------------------------------------------------

const hasDom = typeof window !== "undefined" && typeof document !== "undefined";
const session = (): StorageLike | null => {
  try { return hasDom ? window.sessionStorage : null; } catch { return null; }
};
const DEV = (() => {
  try { return Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV); } catch { return false; }
})();

// Runs when the module loads (api.ts imports it before the app renders): the fragment is gone
// before the hash router looks at the location.
let captured: string | null = hasDom ? captureFragmentToken(window.location, window.history, session()) : null;
const lookup = cacheFound<string>(async () => captured || storedToken(session()) || metaToken()
  || (hasDom ? await desktopToken(window as unknown as TokenWindow) : null));

function metaToken(): string | null {
  if (!hasDom) return null;
  return document.querySelector<HTMLMetaElement>('meta[name="cashu-token"]')?.content || null;
}

/** The API token: "" under `npm run dev` (the proxy adds it), null when none could be found. */
export function apiToken(): Promise<string | null> {
  if (DEV && !captured && !storedToken(session()) && !metaToken()) return Promise.resolve("");
  return lookup.get();
}

/** A 401: the token belongs to an earlier server launch. Forget it, so a reload asks again
 * (desktop bridge) or shows NO_TOKEN_TEXT (browser: open the new URL `cashu serve` printed). */
export function forgetToken(): void {
  captured = null;
  lookup.reset();
  try { session()?.removeItem(TOKEN_STORAGE_KEY); } catch { /* ignore */ }
}
