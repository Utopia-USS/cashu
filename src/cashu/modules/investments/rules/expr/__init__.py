"""Safe expression language of ``custom`` rules (grammar and metric catalog: EXPRESSIONS.md).

Hand-written tokenizer, parser, type checker and evaluator; no Python ``eval``/``exec``/``compile``, no
attribute access, no imports. Only metrics from the fixed catalog can be read.
"""

from __future__ import annotations

from .catalog import METRICS, ArgSpec, MetricSpec, Scope, Unit, ValueType, names_in_scope
from .checker import CompiledExpression, MetricRef, compile_expression
from .evaluator import Evaluation, Unknown, Value, evaluate
from .lexer import ExpressionError

__all__ = [
    "METRICS",
    "ArgSpec",
    "CompiledExpression",
    "Evaluation",
    "ExpressionError",
    "MetricRef",
    "MetricSpec",
    "Scope",
    "Unit",
    "Unknown",
    "Value",
    "ValueType",
    "compile_expression",
    "evaluate",
    "names_in_scope",
]
