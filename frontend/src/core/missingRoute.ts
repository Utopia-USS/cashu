// FastAPI's own 404 / 405 for a route the server does not have (no error code, the generic detail): an older
// server without a newer endpoint. Pure (re-exported by core/api.ts); `npm test` imports it.

export function isMissingRoute(e: unknown): boolean {
  const x = (typeof e === "object" && e !== null ? e : {}) as { status?: number; message?: string; code?: string | null };
  return (x.status === 404 || x.status === 405) && !x.code && /^(not found|method not allowed)$/i.test(x.message ?? "");
}
