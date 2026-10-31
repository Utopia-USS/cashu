// Metro for apps/mobile. Expo detects the pnpm workspace (watch folders, node_modules lookup); Uniwind
// compiles the one token source, packages/ui's Tailwind v4 theme (S50), into React Native styles.
const { getDefaultConfig } = require("expo/metro-config");
const { withUniwindConfig } = require("uniwind/metro");

const config = getDefaultConfig(__dirname);

module.exports = withUniwindConfig(config, {
  cssEntryFile: "../../packages/ui/src/tokens/theme.css",
  dtsFile: "./uniwind-types.d.ts",
});
