// Metro for apps/mobile. Expo detects the pnpm workspace (watch folders, node_modules lookup); Uniwind
// compiles the one token source, packages/ui's Tailwind v4 theme (S50), into React Native styles.
const { getDefaultConfig } = require("expo/metro-config");
const { withUniwindConfig } = require("uniwind/metro");

const config = getDefaultConfig(__dirname);

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
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = withUniwindConfig(config, {
  cssEntryFile: "../../packages/ui/src/tokens/theme.css",
  dtsFile: "./uniwind-types.d.ts",
});
