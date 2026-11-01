// TRANSITIONAL(S49): the sync bridge exists only while the Python app writes (S31a spec 2.1).
//
// Bridges of the core tables (S31a spec 4.4): filled in by C7.
import type { TableBridge } from "./types.js";

export const coreBridges: readonly TableBridge[] = [];
