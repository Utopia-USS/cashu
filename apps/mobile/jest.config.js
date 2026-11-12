// Jest + React Native Testing Library (cashu-ts-architecture testing.md: RNTL for native behaviour).
// Two projects: `native` renders React Native through jest-expo's iOS preset (mocked native modules);
// `node` runs the pure TypeScript tests (store on better-sqlite3, crypto on libsodium-wrappers) on
// jest-expo's Node preset, without the React Native runtime globals the iOS preset installs.
const transformIgnorePatterns = [
  "node_modules/(?!(?:\\.pnpm/[^/]+/node_modules/)?((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|expo-router|@shopify/flash-list|standard-navigation|react-native-svg|uniwind|@cashu/.*|@noble/.*|@scure/.*|zod))",
];
// Workspace packages ship TypeScript sources with NodeNext `.js` specifiers.
const moduleNameMapper = { "^(\\.{1,2}/.*)\\.js$": "$1" };

/** @type {import('jest').Config} */
module.exports = {
  projects: [
    {
      displayName: "native",
      preset: "jest-expo/ios",
      testMatch: ["<rootDir>/src/**/*.test.tsx"],
      // @cashu/ui/native imports gesture handler, Reanimated and worklets (SwipeStack): their Jest stand-ins.
      setupFiles: ["@cashu/ui/jest-native-setup"],
      moduleNameMapper,
      transformIgnorePatterns,
    },
    {
      displayName: "node",
      preset: "jest-expo/node",
      testMatch: ["<rootDir>/src/**/*.test.ts"],
      moduleNameMapper,
      transformIgnorePatterns,
    },
  ],
};
