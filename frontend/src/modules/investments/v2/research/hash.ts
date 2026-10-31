// The research page's selection in the location hash (browser routing, so it stays in the app). Tested in
// tests/research.test.mjs.

/** The location hash with `?segment=<key>` set (or removed for null), other query params kept: the research page
 * writes its selection back with `history.replaceState`, so a reload keeps the filter (no history entries). */
export function hashWithSegment(hash: string, key: string | null): string {
  const i = hash.indexOf("?");
  const path = i < 0 ? hash : hash.slice(0, i);
  const q = new URLSearchParams(i < 0 ? "" : hash.slice(i + 1));
  if (key) q.set("segment", key);
  else q.delete("segment");
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}
