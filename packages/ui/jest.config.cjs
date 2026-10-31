// The React Native side of packages/ui: jest-expo + React Native Testing Library render the native
// renderer (platform.native.tsx, react-native-svg) for every chart story (cashu-ts-architecture testing.md).
/** @type {import('jest').Config} */
module.exports = {
  preset: "jest-expo/ios",
  testMatch: ["<rootDir>/src/**/*.native.test.tsx"],
  // Workspace packages ship TypeScript sources with NodeNext `.js` specifiers.
  moduleNameMapper: { "^(\\.{1,2}/.*)\\.js$": "$1" },
  transformIgnorePatterns: [
    "node_modules/(?!(?:\\.pnpm/[^/]+/node_modules/)?((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|react-native-svg|uniwind|@cashu/.*))",
  ],
};
