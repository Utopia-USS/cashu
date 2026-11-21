/**
 * Recursive-descent parser of the custom-rule expression language (`rules/expr/parser.py`, grammar in
 * EXPRESSIONS.md).
 *
 * Produces an immutable syntax tree. Precedence, lowest first: `or`, `and`, `not`, comparisons
 * (non-associative: `a < b < c` is an error), `+ -`, `* /`, unary `- +`, primaries. Node objects keep
 * the Python dataclass field names (plus a `type` discriminant) so a serializer can emit them 1:1.
 *
 * Recursion is bounded: every construct that nests (parentheses, calls, `not`, unary signs) passes
 * `enter`, which stops at MAX_DEPTH, so a hostile input cannot overflow the stack; left-associative
 * operator chains are built iteratively and their depth is checked after parsing (`checkDepth`).
 */

import { Decimal } from "../../../decimal.js";
import { InvariantError } from "../../domain/values.js";
import { COMPARISON_OPERATORS, ExpressionError, type Token, TokenType, tokenize } from "./lexer.js";
import { MAX_DEPTH, MAX_FUNCTION_ARGS } from "./limits.js";
import { type CompareNode, children, type ExprNode } from "./nodes.js";

/** Tokenizes and parses `source`. Throws `ExpressionError` with a 1-based column. */
export function parse(source: string): ExprNode {
  const tokens = tokenize(source);
  if (tokens[0]?.type === TokenType.END) throw new ExpressionError("Expression is empty", 1);
  const node = new Parser(tokens).parse();
  checkDepth(node);
  return node;
}

// Iterative, with Python's exact visiting order (a LIFO stack extended with the children in order),
// so the node reported for a too-deep tree is the same one.
function checkDepth(root: ExprNode): void {
  const stack: [ExprNode, number][] = [[root, 1]];
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    const [node, depth] = item;
    if (depth > MAX_DEPTH) {
      throw new ExpressionError(
        `Expression is nested too deeply (max ${MAX_DEPTH} levels)`,
        node.column,
      );
    }
    for (const child of children(node)) stack.push([child, depth + 1]);
  }
}

class Parser {
  private readonly tokens: readonly Token[];
  private pos = 0;
  private depth = 0;

  constructor(tokens: readonly Token[]) {
    this.tokens = tokens;
  }

  parse(): ExprNode {
    const node = this.or();
    const token = this.peek();
    if (token.type !== TokenType.END) {
      throw new ExpressionError(
        `Unexpected ${describe(token)} after a complete expression`,
        token.column,
      );
    }
    return node;
  }

  // --- precedence levels ---------------------------------------------------------------------

  private or(): ExprNode {
    return this.logical("or", () => this.and());
  }

  private and(): ExprNode {
    return this.logical("and", () => this.not());
  }

  private logical(op: string, operand: () => ExprNode): ExprNode {
    const first = operand();
    const operands = [first];
    let column = 0;
    while (this.isKeyword(op)) {
      const token = this.advance();
      column = column || token.column;
      operands.push(operand());
    }
    if (operands.length === 1) return first;
    return { type: "Logical", op, operands, column };
  }

  private not(): ExprNode {
    if (this.isKeyword("not")) {
      const token = this.advance();
      return this.nested(token.column, () => ({
        type: "Unary",
        op: "not",
        operand: this.not(),
        column: token.column,
      }));
    }
    return this.comparison();
  }

  private comparison(): ExprNode {
    const left = this.additive();
    const token = this.peek();
    if (token.type !== TokenType.OP || !COMPARISON_OPERATORS.includes(token.text)) return left;
    this.advance();
    const right = this.additive();
    const node: CompareNode = {
      type: "Compare",
      op: token.text,
      left,
      right,
      column: token.column,
    };
    const following = this.peek();
    if (following.type === TokenType.OP && COMPARISON_OPERATORS.includes(following.text)) {
      throw new ExpressionError(
        "Chained comparisons are not supported; combine them with 'and'",
        following.column,
      );
    }
    return node;
  }

  private additive(): ExprNode {
    let node = this.multiplicative();
    while (this.isOp("+", "-")) {
      const token = this.advance();
      const right = this.multiplicative();
      node = { type: "Binary", op: token.text, left: node, right, column: token.column };
    }
    return node;
  }

  private multiplicative(): ExprNode {
    let node = this.unary();
    while (this.isOp("*", "/")) {
      const token = this.advance();
      const right = this.unary();
      node = { type: "Binary", op: token.text, left: node, right, column: token.column };
    }
    return node;
  }

  private unary(): ExprNode {
    if (this.isOp("-", "+")) {
      const token = this.advance();
      return this.nested(token.column, () => ({
        type: "Unary",
        op: token.text,
        operand: this.unary(),
        column: token.column,
      }));
    }
    return this.primary();
  }

  private primary(): ExprNode {
    const token = this.advance();
    switch (token.type) {
      case TokenType.NUMBER:
      case TokenType.PERCENT:
        if (!(token.value instanceof Decimal))
          throw new InvariantError("number token without value");
        return { type: "Number", value: token.value, text: token.text, column: token.column };
      case TokenType.STRING:
        if (typeof token.value !== "string") throw new InvariantError("text token without value");
        return { type: "String", value: token.value, column: token.column };
      case TokenType.KEYWORD:
        if (token.text === "true" || token.text === "false") {
          return { type: "Boolean", value: token.text === "true", column: token.column };
        }
        if (token.text === "not") {
          throw new ExpressionError(
            "'not' must be put in parentheses here, e.g. 1 + (not x)",
            token.column,
          );
        }
        break;
      case TokenType.NAME:
        if (this.peek().type === TokenType.LPAREN) return this.call(token);
        return { type: "Name", name: token.text, column: token.column };
      case TokenType.LPAREN: {
        const inner = this.nested(token.column, () => this.or());
        const closing = this.peek();
        if (closing.type !== TokenType.RPAREN) {
          throw new ExpressionError(
            `Missing ')' for the '(' at column ${token.column}; found ${describe(closing)}`,
            closing.column,
          );
        }
        this.advance();
        return inner;
      }
      case TokenType.END:
        throw new ExpressionError("Expression ended unexpectedly; expected a value", token.column);
      default:
        break;
    }
    throw new ExpressionError(`Expected a value, found ${describe(token)}`, token.column);
  }

  private call(name: Token): ExprNode {
    const opening = this.advance();
    const args = this.nested(opening.column, () => {
      const parsed: ExprNode[] = [];
      if (this.peek().type !== TokenType.RPAREN) {
        while (true) {
          if (parsed.length >= MAX_FUNCTION_ARGS) {
            throw new ExpressionError(
              `Too many arguments for ${name.text} (max ${MAX_FUNCTION_ARGS})`,
              this.peek().column,
            );
          }
          parsed.push(this.or());
          if (this.peek().type !== TokenType.COMMA) break;
          this.advance();
        }
      }
      return parsed;
    });
    const closing = this.peek();
    if (closing.type !== TokenType.RPAREN) {
      throw new ExpressionError(
        `Missing ')' to close ${name.text}( at column ${opening.column}; found ${describe(closing)}`,
        closing.column,
      );
    }
    this.advance();
    return { type: "Call", name: name.text, args, column: name.column };
  }

  // --- helpers -------------------------------------------------------------------------------

  /** Python `_enter` + `try: ... finally: self._depth -= 1` around one nesting construct. */
  private nested<T>(column: number, body: () => T): T {
    this.depth += 1;
    try {
      if (this.depth > MAX_DEPTH) {
        throw new ExpressionError(
          `Expression is nested too deeply (max ${MAX_DEPTH} levels)`,
          column,
        );
      }
      return body();
    } finally {
      this.depth -= 1;
    }
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private advance(): Token {
    const token = this.tokens[this.pos] as Token;
    if (token.type !== TokenType.END) this.pos += 1;
    return token;
  }

  private isKeyword(keyword: string): boolean {
    const token = this.peek();
    return token.type === TokenType.KEYWORD && token.text === keyword;
  }

  private isOp(...ops: string[]): boolean {
    const token = this.peek();
    return token.type === TokenType.OP && ops.includes(token.text);
  }
}

function describe(token: Token): string {
  if (token.type === TokenType.END) return "the end of the expression";
  return `'${token.text}'`;
}
