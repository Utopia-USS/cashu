/** The not-a-subscription categories the categorizer tests run with (tests only). */
import { builtinRegistry, notSubscriptionCategories } from "../../../core/index.js";
import { NOT_SUBSCRIPTION_CATEGORIES } from "../recurring.js";

export const NOT_SUBSCRIPTION: ReadonlySet<string> = new Set([
  ...NOT_SUBSCRIPTION_CATEGORIES,
  ...notSubscriptionCategories(builtinRegistry()),
]);
