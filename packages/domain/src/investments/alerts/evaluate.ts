/** One alert's failure becomes Skipped, never a false resolution or a failed profile run. */

import { DecimalError } from "../../decimal.js";
import { expr } from "../rules/index.js";
import { dynamicEvaluate } from "./dynamicEvaluate.js";
import { skip } from "./evaluateSupport.js";
import { portfolioEvaluate } from "./portfolioEvaluate.js";
import { priceEvaluate } from "./priceEvaluate.js";
import type { AlertCheck, AlertData, AlertDefinition } from "./types.js";
export function evaluateAlert(alert: AlertDefinition, data: AlertData): AlertCheck {
  try {
    switch (alert.kind) {
      case "price_above":
      case "price_below":
      case "change_pct":
      case "drawdown_from_high":
      case "new_high":
      case "sma_cross":
        return priceEvaluate(alert, data);
      case "range_breakout":
      case "volume_spike":
        return dynamicEvaluate(alert, data);
      case "weight_above":
      case "weight_below":
      case "custom":
        return portfolioEvaluate(alert, data);
    }
    // Stored/external runtime values still cross this boundary after static union checking.
    const error = new Error(`unknown alert kind ${alert.kind}`);
    error.name = "AssertionError";
    throw error;
  } catch (error) {
    // Python's ratio formatter quantizes nonfinite Decimal values and raises InvalidOperation.
    if (error instanceof DecimalError && error.signal === "NonFinite")
      return skip(alert, "Alert failed: InvalidOperation: [<class 'decimal.InvalidOperation'>]");
    const message =
      error instanceof expr.ExpressionError
        ? String(error)
        : error instanceof Error
          ? error.message
          : String(error);
    return skip(
      alert,
      `Alert failed: ${error instanceof Error ? error.name : "Error"}: ${message}`,
    );
  }
}
