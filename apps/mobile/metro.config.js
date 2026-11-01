// Metro for apps/mobile. Expo detects the pnpm workspace (watch folders, node_modules lookup); Uniwind
// compiles the one token source, packages/ui's Tailwind v4 theme (S50), into React Native styles.
const { getDefaultConfig } = require("expo/metro-config");
const { withUniwindConfig } = require("uniwind/metro");
const { basename, dirname, join } = require("node:path");

const config = getDefaultConfig(__dirname);
const zodLocalesDirectory = dirname(require.resolve("zod/v4/locales"));
const mobileZodLocales = join(__dirname, "src/platform/zodLocales.ts");

// The workspace packages are TypeScript sources written for `moduleResolution: NodeNext`, so their
// relative imports name the emitted file (`./catalog.js` for catalog.ts). TypeScript and Node resolve
// that; Metro needs the same rule: a relative `.js` import from a .ts / .tsx file is tried without the
// extension first (then Metro's source extensions pick the .ts file).
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (
    moduleName.startsWith(".") &&
    moduleName.endsWith(".js") &&
    /\.tsx?$/.test(context.originModulePath)
  ) {
    try {
      return context.resolveRequest(context, moduleName.slice(0, -3), platform);
    } catch {
      // not a TypeScript source: fall through to the import as written
    }
  }
  const resolved = context.resolveRequest(context, moduleName, platform);
  // Zod's core and classic barrels export every locale. Metro keeps the namespace, even though
  // validation errors use only the default English map. Keep that exact map via its public subpath.
  // https://zod.dev/error-customization#internationalization
  if (
    resolved.type === "sourceFile" &&
    dirname(resolved.filePath) === zodLocalesDirectory &&
    /^index\.(?:c?js|ts)$/.test(basename(resolved.filePath))
  ) {
    return { type: "sourceFile", filePath: mobileZodLocales };
  }
  return resolved;
};

module.exports = withUniwindConfig(config, {
  cssEntryFile: "../../packages/ui/src/tokens/theme.css",
  dtsFile: "./uniwind-types.d.ts",
});
