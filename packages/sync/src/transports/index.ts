// Transports move opaque segment bytes. Folder (S28c): a directory replicated by iCloud Drive or
// Syncthing, over a platform-free file-system port the app wires (Node fs on the desktop).
export * from "./firestore/index.js";
export type { FolderEntry, FolderFs } from "./folder/fs.js";
export { parseSegmentName, type SegmentName, segmentFileName } from "./folder/names.js";
export {
  type FolderStatus,
  FolderTransport,
  type FolderTransportOptions,
} from "./folder/transport.js";
