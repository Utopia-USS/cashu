// Jest setup for every project that renders `@cashu/ui/native` (this package's native tests and
// apps/mobile): the phone's display layer imports react-native-gesture-handler, Reanimated 4 and
// react-native-worklets (SwipeStack), whose native modules do not exist under Jest. Gesture handler
// ships its own stand-ins, worklets its published mock; Reanimated's published mock loads its web
// runtime (react-native-web, not a dependency), so it runs on a small local stand-in.
require("react-native-gesture-handler/jestSetup");
// react-native-worklets 0.13.0 has no `exports` map and no published `mock` entry: its mock lives at
// `src/mock` (re-check this path on a worklets bump).
jest.mock("react-native-worklets", () => require("react-native-worklets/src/mock"));
jest.mock("react-native-reanimated", () => require("./reanimatedMock.native"));
