"""The Python half of the demographics parity corpus.

`tests/fixtures/demographics_corpus.json` is read by this file and by
`extension/privacy/parse.test.js`. Fourteen pasted notes, and for each one the
exact record both parsers must produce — values, where each came from, and
which fields came back as a question rather than an answer.

This is the guard on the port that moved parsing into the browser. A parser
that misses a value does not leak it; the field stays blank and the doctor
types it. What it does instead is leave that value out of the redaction
dictionary, so a name the browser's copy fails to find is a name `redact.js`
is never told to remove. That is a leak one step removed from its cause, which
is precisely the kind that survives review.

Neither language generates this file. An expectation a parser writes for
itself asserts nothing at all.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from demographics import parse_demographics

CORPUS = json.loads(
    (Path(__file__).parent / "fixtures" / "demographics_corpus.json").read_text(
        encoding="utf-8"
    )
)
CASES = CORPUS["cases"]


def test_the_corpus_was_actually_read() -> None:
    # A fixture that silently became empty would make every test below pass by
    # having nothing to run.
    assert len(CASES) >= 14
    assert all(case["note"].strip() for case in CASES)


@pytest.mark.parametrize("case", CASES, ids=[c["id"] for c in CASES])
def test_the_values_are_what_the_corpus_says(case: dict) -> None:
    parsed = parse_demographics(case["note"], case["known_name"])
    expected = case["expect"]
    for field in (
        "full_name", "nric", "dob", "phone", "address", "policy_number", "insurer",
    ):
        assert getattr(parsed, field) == expected[field], field


@pytest.mark.parametrize("case", CASES, ids=[c["id"] for c in CASES])
def test_where_each_value_came_from_is_what_the_corpus_says(case: dict) -> None:
    # Not decoration. "labelled" and "sole-match" are different amounts of
    # evidence, and a change that quietly moved a field from one to the other
    # would pass a values-only assertion while having changed what the parser
    # is willing to believe.
    assert parse_demographics(case["note"], case["known_name"]).sources == case["expect"]["sources"]


@pytest.mark.parametrize("case", CASES, ids=[c["id"] for c in CASES])
def test_the_questions_are_what_the_corpus_says(case: dict) -> None:
    # A blank that is a refusal and a blank that is a miss look identical in
    # the values, and only one of them should reach the doctor as a pick-list.
    assert parse_demographics(case["note"], case["known_name"]).choices == case["expect"]["choices"]
