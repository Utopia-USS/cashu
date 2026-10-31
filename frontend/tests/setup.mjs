// Loaded with `--import` before every test file (`npm test`). Two jobs:
// 1. Node's type stripping runs the workspace packages' TypeScript (@cashu/i18n, @cashu/ui-logic), which
//    import their siblings as `./x.js` (the NodeNext convention of packages/): such a relative specifier that
//    does not resolve is retried as `./x.ts`. Nothing else is rewritten.
// 2. Tests run in Polish, so the existing assertions keep their Polish text; `setLanguageForTests("en")`
//    switches (there is no browser language source here, docs/agents/localization.md).
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      const relativeJs = (specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js");
      if (!relativeJs) throw error;
      return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
    }
  },
});

const { setLanguageForTests } = await import("@cashu/i18n");
setLanguageForTests("pl");
