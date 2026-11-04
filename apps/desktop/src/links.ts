/** Port of desktop/notify.py `link_to_hash` and `LinkRouter`: `cashu://` links (notification
 * clicks, other programs) open a dashboard view. Links come from outside the app, so only the
 * known shapes with a slug-shaped profile and a numeric id are accepted. */

export const LINK_SCHEME = "cashu";
export const MAX_LINK = 512;
export const INVESTMENTS_VIEW = "investments.portfolio";

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ID = /^[0-9]{1,12}$/;

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * The dashboard hash route for a `cashu://` link:
 * "" = just bring the app to the front, null = not a link this app opens.
 */
export function linkToHash(url: unknown): string | null {
  if (typeof url !== "string" || url.length > MAX_LINK) return null;
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)([?#].*)?$/i.exec(url);
  if (!match) return null;
  const scheme = (match[1] ?? "").toLowerCase();
  if (scheme !== LINK_SCHEME || match[4]) return null;
  const kind = match[2] ?? "";
  const segs = (match[3] ?? "").split("/").filter(Boolean).map(decode);
  if (kind === "open" && segs.length === 0) return "";
  const slug = segs[0];
  if (!slug || !SLUG.test(slug)) return null;
  const id = segs[1];
  if (kind === "signal" && segs.length === 2 && id && ID.test(id)) {
    return `#/${slug}/${INVESTMENTS_VIEW}/?signal=${Number(id)}`;
  }
  if (kind === "review" && segs.length === 1) return `#/${slug}/${INVESTMENTS_VIEW}/?review=1`;
  if (kind === "investments" && segs.length === 1) return `#/${slug}/${INVESTMENTS_VIEW}`;
  return null;
}

/** The first `cashu://` link in a command line (second instance, `open -a ... --args`). */
export function linkFromArgv(argv: readonly string[]): string | null {
  for (const arg of argv) {
    const value = arg.startsWith("--open-link=") ? arg.slice("--open-link=".length) : arg;
    if (linkToHash(value) !== null) return value;
  }
  return null;
}

/** What the router needs from the window. */
export interface LinkWindow {
  currentUrl(): string;
  loadUrl(url: string): Promise<void>;
  setHash(hash: string): Promise<void>;
  show(): void;
}

/**
 * Opens links in the window. Before the dashboard has loaded the latest link is kept and `ready`
 * folds it into the first URL; afterwards a link changes the hash route in place (no reload, the
 * page keeps its state) and brings the window forward.
 */
export class LinkRouter {
  private window: LinkWindow | null = null;
  private base: string | null = null;
  private pending: string | null = null;

  /** The window is about to load `baseUrl`: the URL to load (with a pending link's route). */
  ready(window: LinkWindow, baseUrl: string): string {
    this.window = window;
    this.base = baseUrl;
    const pending = this.pending;
    this.pending = null;
    return pending ? baseUrl + pending : baseUrl;
  }

  open(url: unknown): boolean {
    const target = linkToHash(url);
    if (target === null) return false;
    const { window, base } = this;
    if (!window || !base) {
      if (target) this.pending = target;
      return true;
    }
    void this.navigate(window, base, target);
    return true;
  }

  private async navigate(window: LinkWindow, base: string, target: string): Promise<void> {
    try {
      if (target) {
        if (window.currentUrl().startsWith(base)) await window.setHash(target);
        else await window.loadUrl(base + target);
      }
      window.show();
    } catch {
      // a window that is gone cannot show a link
    }
  }
}
