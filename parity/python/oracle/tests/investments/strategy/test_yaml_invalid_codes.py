"""A YAML error is one line with the stable code ``strategy.yaml_invalid`` (F7-FIX2 B6): a control
character (PyYAML's reader error has no mark and a multi-line text) gets PyYAML's problem sentence as
``problem`` and the character's line / column; a positioned parser error is unchanged."""

from __future__ import annotations

from cashu.modules.investments.strategy import load_strategy
from cashu.modules.investments.strategy.codes import classify


def _issue(text: str):
    (issue,) = load_strategy(text, "").issues
    return issue


def test_a_control_character_is_yaml_invalid_with_its_position():
    issue = _issue("version: 1\nbase_currency: PLN\x01\n")
    problem = "unacceptable character #x0001: special characters are not allowed"
    assert issue.message == f"Invalid YAML: {problem}"
    assert "\n" not in issue.message
    assert issue.code == "strategy.yaml_invalid" and issue.params == {"problem": problem}
    assert (issue.line, issue.column) == (2, 19)


def test_a_positioned_parser_error_is_unchanged():
    issue = _issue("version: 1\nbase_currency: [PLN\n")
    problem = "expected ',' or ']', but got '<stream end>' (while parsing a flow sequence)"
    assert issue.message == f"Invalid YAML: {problem}"
    assert issue.code == "strategy.yaml_invalid" and issue.params == {"problem": problem}
    assert (issue.line, issue.column) == (3, 1)


def test_a_multi_line_message_still_classifies_with_the_first_line():
    message = (
        "Invalid YAML: unacceptable character #x0001: special characters are not allowed\n"
        '  in "<unicode string>", position 29'
    )
    assert classify(message) == (
        "strategy.yaml_invalid",
        {"problem": "unacceptable character #x0001: special characters are not allowed"},
    )
