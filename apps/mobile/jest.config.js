// Jest + React Native Testing Library (cashu-ts-architecture testing.md: RNTL for native behaviour).
// jest-expo mocks the native modules; store tests run the real store on better-sqlite3.
/** @type {import('jest').Config} */
module.exports = {
  preset: "jest-expo/ios",
  testMatch: ["<rootDir>/src/**/*.test.ts?(x)"],
  // Workspace packages ship TypeScript sources with NodeNext `.js` specifiers.
  moduleNameMapper: { "^(\\.{1,2}/.*)\\.js$": "$1" },
  transformIgnorePatterns: [
    "node_modules/(?!(?:\\.pnpm/[^/]+/node_modules/)?((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|expo-router|@shopify/flash-list|uniwind|@cashu/.*|@noble/.*|@scure/.*|zod))",
  ],
};
