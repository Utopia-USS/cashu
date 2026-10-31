/// <reference types="node" />
/**
 * Loaded with `--import` by the producer CLI: lets Node's type stripping run workspace TypeScript that
 * imports its siblings as `./x.js` (the NodeNext convention `@cashu/domain` uses) by retrying such a
 * relative specifier as `./x.ts`. Nothing else is rewritten.
 */

import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      const relativeJs =
        (specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js");
      if (!relativeJs) throw error;
      return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
    }
  },
});
