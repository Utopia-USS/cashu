/**
 * Safe expression language of `custom` rules, compile front-end (`rules/expr/__init__.py`; grammar and
 * metric catalog: EXPRESSIONS.md).
 *
 * Hand-written tokenizer, parser and type checker; no `eval` / `Function`, no attribute access, no
 * imports. Only metrics from the fixed catalog can be read; pure evaluation and metric resolution
 * operate on caller-supplied portfolio inputs.
 */

export { ASSET_CLASS_NAMES, METRICS, namesInScope } from "./catalog.js";
export {
  type ArgSpec,
  isFunction,
  type MetricSpec,
  parseScope,
  SCOPES,
  Scope,
  signature,
  Unit,
  ValueType,
} from "./catalogTypes.js";
export { compileExpression } from "./checker.js";
export {
  bucketReferences,
  type CompiledExpression,
  type MetricRef,
  metricLabel,
  normalized,
} from "./compiled.js";
export {
  type Evaluation,
  evaluateExpression,
  type MetricResolver,
  Unknown,
  type Value,
} from "./evaluator.js";
export { ExpressionError, type Token, TokenType, tokenize } from "./lexer.js";
export * from "./limits.js";
export { MetricEnv } from "./metrics.js";
export {
  type BinaryNode,
  type BooleanNode,
  type CallNode,
  type CompareNode,
  children,
  type ExprNode,
  type LogicalNode,
  type NameNode,
  type NumberNode,
  type StringNode,
  type UnaryNode,
} from "./nodes.js";
export { parse } from "./parser.js";
