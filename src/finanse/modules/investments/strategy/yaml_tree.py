"""strategy.yaml as a located node tree (PyYAML ``compose``), with the safety checks plain loading lacks:
duplicate keys, anchors/aliases, merge keys, custom tags and size limits are rejected with a location."""

from __future__ import annotations

from dataclasses import dataclass

import yaml
from yaml.constructor import ConstructorError, SafeConstructor
from yaml.nodes import MappingNode, Node, ScalarNode, SequenceNode

MAX_STRATEGY_CHARS = 512_000
"""Largest strategy.yaml accepted (a real one is a few kB)."""

MAX_YAML_DEPTH = 32
"""Deepest mapping / list nesting accepted (the schema needs 5)."""

_SCALAR_TAGS = {
    "tag:yaml.org,2002:str",
    "tag:yaml.org,2002:int",
    "tag:yaml.org,2002:float",
    "tag:yaml.org,2002:bool",
    "tag:yaml.org,2002:null",
    "tag:yaml.org,2002:timestamp",
}
_MAP_TAG = "tag:yaml.org,2002:map"
_SEQ_TAG = "tag:yaml.org,2002:seq"
_MERGE_TAG = "tag:yaml.org,2002:merge"
_NULL_TAG = "tag:yaml.org,2002:null"


class YamlTreeError(Exception):
    """The document cannot be used at all; ``line`` / ``column`` are 1-based (None when unknown)."""

    def __init__(self, message: str, line: int | None = None, column: int | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.line = line
        self.column = column


@dataclass(frozen=True, slots=True)
class Entry:
    """One mapping entry with its located key and value nodes."""

    key: str
    key_node: Node
    value: Node


def compose(text: str) -> Node | None:
    """The single document of ``text`` as a node tree (None for an empty document)."""
    if len(text) > MAX_STRATEGY_CHARS:
        raise YamlTreeError(
            f"strategy.yaml is too large ({len(text)} characters, max {MAX_STRATEGY_CHARS})"
        )
    try:
        _prescan(text)
        root = yaml.compose(text, Loader=yaml.SafeLoader)
    except yaml.MarkedYAMLError as error:
        mark = error.problem_mark or error.context_mark
        problem = error.problem or error.context or "syntax error"
        context = f" ({error.context})" if error.context and error.problem else ""
        raise YamlTreeError(
            f"Invalid YAML: {problem}{context}",
            None if mark is None else mark.line + 1,
            None if mark is None else mark.column + 1,
        ) from None
    except yaml.reader.ReaderError as error:  # a character YAML refuses (a control character)
        line = column = None
        if isinstance(error.position, int):
            line = text.count("\n", 0, error.position) + 1
            column = error.position - (text.rfind("\n", 0, error.position) + 1) + 1
        raise YamlTreeError(f"Invalid YAML: {_first_line(error)}", line, column) from None
    except yaml.YAMLError as error:
        raise YamlTreeError(f"Invalid YAML: {_first_line(error)}") from None
    except RecursionError:
        raise YamlTreeError("Invalid YAML: the document is nested too deeply") from None
    if root is not None:
        _check(root)
    return root


def _first_line(error: Exception) -> str:
    """PyYAML's problem sentence: the first line of its message (the next lines name the stream and
    a position, which the issue carries as line / column instead)."""
    return str(error).strip().splitlines()[0] if str(error).strip() else "syntax error"


def _prescan(text: str) -> None:
    """Rejects aliases and deep nesting on the (iterative) event stream, before any tree is built."""
    depth = 0
    for event in yaml.parse(text, Loader=yaml.SafeLoader):
        if isinstance(event, yaml.AliasEvent):
            raise YamlTreeError(
                "YAML anchors and aliases (& and *) are not supported",
                event.start_mark.line + 1,
                event.start_mark.column + 1,
            )
        if isinstance(event, yaml.MappingStartEvent | yaml.SequenceStartEvent):
            depth += 1
            if depth > MAX_YAML_DEPTH:
                raise YamlTreeError(
                    f"strategy.yaml is nested too deeply (max {MAX_YAML_DEPTH} levels)",
                    event.start_mark.line + 1,
                    event.start_mark.column + 1,
                )
        elif isinstance(event, yaml.MappingEndEvent | yaml.SequenceEndEvent):
            depth -= 1


def _check(root: Node) -> None:
    """Rejects aliases (a node reached twice), custom tags, merge keys, non-text and duplicate keys."""
    seen: set[int] = set()
    stack: list[Node] = [root]
    while stack:
        node = stack.pop()
        if id(node) in seen:
            raise YamlTreeError(
                "YAML anchors and aliases (& and *) are not supported", *position(node)
            )
        seen.add(id(node))
        if isinstance(node, ScalarNode):
            if node.tag not in _SCALAR_TAGS:
                raise YamlTreeError(f"Unsupported YAML tag {node.tag}", *position(node))
        elif isinstance(node, SequenceNode):
            if node.tag != _SEQ_TAG:
                raise YamlTreeError(f"Unsupported YAML tag {node.tag}", *position(node))
            stack.extend(node.value)
        elif isinstance(node, MappingNode):
            if node.tag != _MAP_TAG:
                raise YamlTreeError(f"Unsupported YAML tag {node.tag}", *position(node))
            first_line: dict[str, int] = {}
            for key_node, value_node in node.value:
                if isinstance(key_node, ScalarNode) and key_node.tag == _MERGE_TAG:
                    raise YamlTreeError(
                        "YAML merge keys (<<) are not supported", *position(key_node)
                    )
                if not isinstance(key_node, ScalarNode):
                    raise YamlTreeError("Mapping keys must be plain text", *position(key_node))
                key = key_node.value
                line = position(key_node)[0]
                if key in first_line:
                    raise YamlTreeError(
                        f'Invalid YAML: duplicate mapping key "{key}" (first defined on line '
                        f"{first_line[key]})",
                        *position(key_node),
                    )
                first_line[key] = line
                stack.append(key_node)
                stack.append(value_node)


def position(node: Node) -> tuple[int, int]:
    """1-based (line, column) of the node's start."""
    return node.start_mark.line + 1, node.start_mark.column + 1


def is_absent(node: Node | None) -> bool:
    """Absent or explicit YAML null (``key:`` with nothing after it)."""
    return node is None or (isinstance(node, ScalarNode) and node.tag == _NULL_TAG)


def entries(node: MappingNode) -> list[Entry]:
    return [Entry(key_node.value, key_node, value) for key_node, value in node.value]


def get(node: MappingNode, key: str) -> Node | None:
    """The value node of ``key`` in ``node``, or None."""
    for key_node, value in node.value:
        if key_node.value == key:
            return value
    return None


def to_plain(node: Node) -> object:
    """Python value of ``node``: dict (text keys) / list / str / int / float / bool / None / date."""
    if isinstance(node, MappingNode):
        return {key_node.value: to_plain(value) for key_node, value in node.value}
    if isinstance(node, SequenceNode):
        return [to_plain(item) for item in node.value]
    assert isinstance(node, ScalarNode)
    if node.tag == "tag:yaml.org,2002:str":
        return node.value
    try:
        return SafeConstructor().construct_object(node, deep=True)
    except (ConstructorError, ValueError):
        return node.value


def plain_map(node: MappingNode) -> dict[str, object]:
    value = to_plain(node)
    assert isinstance(value, dict)
    return value


def locate(base: Node, key: str, *, key_node: bool) -> Node | None:
    """The node at ``key`` (``threshold``, ``asset_class[1]``, ``a.b``) below ``base``.

    For the last mapping key: the key node itself when ``key_node`` (unknown-key warnings), else its
    value. Falls back to the deepest node found; None when not even the first step resolves.
    """
    if not key:
        return base
    steps: list[str | int] = []
    for part in key.split("."):
        name, _, rest = part.partition("[")
        if name:
            steps.append(name)
        if rest:
            for index in ("[" + rest).split("[")[1:]:
                digits = index.rstrip("]")
                if not digits.isdigit():
                    return None
                steps.append(int(digits))
    current: Node | None = base
    found: Node | None = None
    for i, step in enumerate(steps):
        following: Node | None = None
        if isinstance(step, str) and isinstance(current, MappingNode):
            for candidate, value in current.value:
                if candidate.value == step:
                    following = candidate if key_node and i == len(steps) - 1 else value
                    break
        elif (
            isinstance(step, int)
            and isinstance(current, SequenceNode)
            and step < len(current.value)
        ):
            following = current.value[step]
        if following is None:
            return found
        found = following
        current = following
    return found


def exact_column(source: str, node: Node, offset: int) -> int | None:
    """1-based column of character ``offset`` of a single-line scalar's text, when the YAML source shows
    that text verbatim (plain or quoted without escapes); None otherwise (block scalars, escapes)."""
    if not isinstance(node, ScalarNode) or node.start_mark.line != node.end_mark.line:
        return None
    quote = 1 if node.style in ("'", '"') else 0
    start = node.start_mark.index + quote
    if source[start : start + len(node.value)] != node.value:
        return None
    return node.start_mark.column + 1 + quote + offset
