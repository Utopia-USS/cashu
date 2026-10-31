/** Lookup of a `{ pl, en }` text by a dynamic id in a macro catalog (own keys only). */

export interface Texts {
  readonly pl: string;
  readonly en: string;
}

/** The entry `id` of `catalog`, or null (an inherited property such as `constructor` never counts). */
export function textsOf(catalog: Readonly<Record<string, Texts>>, id: string): Texts | null {
  return Object.hasOwn(catalog, id) ? (catalog[id] ?? null) : null;
}
