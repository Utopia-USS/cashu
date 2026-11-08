// Encrypted native pre-merge checkpoint. No same-writer restoration or activation API.
export { createNativeCheckpoint } from "./nativeCheckpoint/capture.js";
export { scrubIncompleteNativeCheckpoints } from "./nativeCheckpoint/fs.js";
