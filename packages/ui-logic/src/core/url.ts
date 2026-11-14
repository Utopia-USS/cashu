/** The host of an absolute URL without a leading "www." ("https://www.bankier.pl/forum" -> "bankier.pl"), else
 * null. Pure, without the WHATWG `URL` (React Native implements it only in part): `scheme://[user@]host[:port]`,
 * the host lowercased as `URL.hostname` gives it; an internationalized host stays as written (`URL` would give
 * its punycode) and a URL without an authority part gives null. */
export function hostOf(url: string | null | undefined): string | null {
  const m = /^\s*[a-z][a-z\d+.-]*:\/\/(?:[^@/?#\\]*@)?(\[[^\]]*\]|[^/?#:\\\s]+)/i.exec(url ?? "");
  return m?.[1] ? m[1].toLowerCase().replace(/^www\./, "") : null;
}
