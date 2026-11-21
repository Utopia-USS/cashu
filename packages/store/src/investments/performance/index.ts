// The investments performance service over a vault (S19b, Python `performance/service.py` and
// `backfill.py`): inputs loaded from the view and the device's price cache, the cached full-history
// computation and its views, and the leader's price backfill. The pure parts live in
// `@cashu/domain` (`investments.performance`).
export {
  type BackfillDeps,
  type BackfillResult,
  type EnsuredProxy,
  ensureProxy,
  isReferenceOnly,
  runBackfill,
  settleProxyCurrency,
} from "./backfill.js";
export { findProxy, type InputsRequest, performanceInputs } from "./inputs.js";
export {
  CACHE_SIZE,
  PerformanceService,
  type ViewRequest,
  type ViewResult,
} from "./service.js";
