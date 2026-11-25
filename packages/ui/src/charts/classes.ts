/** Joins the truthy class parts. */
export const cls = (...parts: (string | false | null | undefined)[]): string =>
  parts.filter(Boolean).join(" ");
