import { linkToHash } from "./links.js";

/** Port of the request validation of desktop/notify.py `NativeRequest.from_payload`. */

const GROUP = /^[A-Za-z0-9._-]{1,128}$/;

export interface NativeRequest {
  identifier: string;
  title: string;
  subtitle: string;
  message: string;
  url: string | null;
}

function text(data: Record<string, unknown>, key: string, limit: number, required = false): string {
  const value = data[key];
  if (value === undefined || value === null) {
    if (!required) return "";
    throw new TypeError(`${key}: expected text`);
  }
  if (typeof value !== "string" || (required && !value.trim())) {
    throw new TypeError(`${key}: expected text`);
  }
  return value.split(/\s+/).filter(Boolean).join(" ").slice(0, limit);
}

export function requestFromPayload(
  data: unknown,
  newId: () => string = () => crypto.randomUUID().replaceAll("-", ""),
): NativeRequest {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new TypeError("expected a JSON object");
  }
  const payload = data as Record<string, unknown>;
  const group = payload.group;
  if (group !== undefined && group !== null && (typeof group !== "string" || !GROUP.test(group))) {
    throw new TypeError("group: expected letters, digits, '.', '_' or '-'");
  }
  let url = payload.url;
  if (url !== undefined && url !== null && linkToHash(url) === null) url = null; // never attach a link the app would not open
  return {
    identifier: typeof group === "string" && group ? group : `cashu-${newId()}`,
    title: text(payload, "title", 120, true),
    subtitle: text(payload, "subtitle", 120),
    message: text(payload, "message", 400, true),
    url: typeof url === "string" ? url : null,
  };
}

/** The slice of Electron's `Notification` the notifier uses. */
export interface NativeNotification {
  show(): void;
  close(): void;
  on(event: "click", listener: () => void): unknown;
}

export interface NotifierDeps {
  supported(): boolean;
  create(options: { title: string; subtitle: string; body: string }): NativeNotification;
  /** A click on the notification: opens its link (or just fronts the window). */
  onClick(url: string | null): void;
}

export type PostResult = { status: "posted" } | { status: "unsupported" };

/**
 * Posts native notifications from the main process (the worker of S40 will live there). A new
 * notification with the same group replaces the earlier one, as the macOS thread identifier does
 * in the Python helper.
 */
export class Notifier {
  private readonly shown = new Map<string, NativeNotification>();

  private readonly deps: NotifierDeps;
  constructor(deps: NotifierDeps) {
    this.deps = deps;
  }

  post(request: NativeRequest): PostResult {
    if (!this.deps.supported()) return { status: "unsupported" };
    this.shown.get(request.identifier)?.close();
    const notification = this.deps.create({
      title: request.title,
      subtitle: request.subtitle,
      body: request.message,
    });
    notification.on("click", () => this.deps.onClick(request.url));
    this.shown.set(request.identifier, notification);
    notification.show();
    return { status: "posted" };
  }
}
