/** Current native policy, independent of execution and provider capabilities. */
import type { Privacy } from "../privacy/redactor.js";
export interface NativePolicy {
  readonly privacy: Privacy;
  readonly modules: ReadonlySet<string>;
}
