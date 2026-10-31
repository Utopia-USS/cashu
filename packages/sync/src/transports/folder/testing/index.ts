// Test kit for the folder transport (`@cashu/sync/testing/folder`): an in-memory file system, a Node
// fs adapter for temp directories, and a file-sync service simulation. Node-only; never import it
// from runtime code.
export { CloudSim, type CloudSimOptions, seededRandom } from "./cloud.js";
export { MemoryFolderFs } from "./memory-fs.js";
export { NodeFolderFs } from "./node-fs.js";
