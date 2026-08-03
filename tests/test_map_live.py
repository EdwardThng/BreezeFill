"""The schema-free fill path (POST /map-live).

This is the fallback for a form nobody has written a schema for: the field
list comes off the live page instead of out of `backend/schemas/`. Two things
change as a result, and both are tested here.

1. **Page structure becomes an LLM input.** The schema path never sends it.
   Labels are scrubbed in the browser and again on the way in, so the tests
   that matter are the ones asserting an identifier planted in a *label* does
   not reach the model — with the known, unclosable hole that a name has no
   shape.
2. **The model is told less.** A schema's description is an instruction; a
   live page only has the question as it is worded. Nothing to assert, but it
   is why `_live_schema` carries the comment it does.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).parent))

import main
from mapping import FieldAnswer

client = TestClient(main.app)

PATIENT = {
    "full_name": "Tan Wei Ming",
    "nric": "S1234567A",
    "dob": "1962-03-14",
    "phone": "91234567",
    "insurer": "Great Eastern",
    "clinical_text": "Mr Tan Wei Ming (S1234567A) seen 02/06/2026, RIF pain. Dx appendicitis.",
}

LIVE_FIELDS = [
    {"label": "Diagnosis of all conditions treated", "type": "text"},
    {"label": "ICD-10 Code", "type": "text"},
    {"label": "Date of admission", "type": "date"},
    {"label": "Was surgery performed?", "type": "radio-group"},
]


@pytest.fixture(autouse=True)
def stub_llm(monkeypatch):
    """No real LLM calls. Captures the schema the endpoint built, which is the
    thing under test — everything downstream of it is already covered."""
    seen = {}

    def fake_map_fields(schema, redacted_text, client=None, model=None):
        seen["schema"] = schema
        seen["redacted_text"] = redacted_text
        return {f.id: FieldAnswer(value=None, status="missing", source=None) for f in schema.fields}

    monkeypatch.setattr(main, "map_fields", fake_map_fields)
    monkeypatch.setenv("FORMFILL_DISABLE_SWEEP", "1")
    return seen


def post(fields, patient=None):
    return client.post("/map-live", json={"fields": fields, "patient": patient or PATIENT})


class TestMapping:
    def test_a_page_with_no_schema_still_produces_review_rows(self, stub_llm) -> None:
        response = post(LIVE_FIELDS)
        assert response.status_code == 200, response.text
        rows = response.json()["fields"]
        assert [r["label"] for r in rows] == [f["label"] for f in LIVE_FIELDS]

    def test_ids_are_slugs_of_the_labels(self, stub_llm) -> None:
        post(LIVE_FIELDS)
        assert [f.id for f in stub_llm["schema"].fields] == [
            "diagnosis_of_all_conditions_treated",
            "icd_10_code",
            "date_of_admission",
            "was_surgery_performed",
        ]

    def test_duplicate_labels_still_get_distinct_ids(self, stub_llm) -> None:
        # Ids become the enum the model answers against, so a collision would
        # silently merge two questions into one answer.
        post([{"label": "Date"}, {"label": "Date"}, {"label": "Date"}])
        ids = [f.id for f in stub_llm["schema"].fields]
        assert ids == ["date", "date_2", "date_3"]
        assert len(set(ids)) == 3

    def test_control_types_are_normalised(self, stub_llm) -> None:
        post(LIVE_FIELDS)
        by_id = {f.id: f.type for f in stub_llm["schema"].fields}
        assert by_id["date_of_admission"] == "date"
        # A radio group asking a yes/no question is a checkbox to the mapper.
        assert by_id["was_surgery_performed"] == "checkbox"
        assert by_id["icd_10_code"] == "text"

    def test_it_is_a_web_schema_with_no_pdf(self, stub_llm) -> None:
        post(LIVE_FIELDS)
        assert stub_llm["schema"].fill_mode == "web"
        assert stub_llm["schema"].pdf_path == ""

    def test_nothing_is_stored(self, stub_llm) -> None:
        before = len(main._claims)
        post(LIVE_FIELDS)
        assert len(main._claims) == before


class TestRefusals:
    def test_a_page_with_no_labels_is_refused_not_mapped(self, stub_llm) -> None:
        # Every label empty is what an unreadable page looks like — and before
        # rule 6 in dump.js, what RoboForm looked like. Mapping it would send a
        # clinical note off to answer nothing.
        response = post([{"label": ""}, {"label": "   "}])
        assert response.status_code == 422
        assert "schema" not in stub_llm

    def test_too_many_fields_is_refused_rather_than_truncated(self, stub_llm) -> None:
        # The structured-output grammar is size-bounded. A silently dropped
        # field is indistinguishable from one the model had nothing to say
        # about, which is the worst way to lose it.
        response = post([{"label": f"Question {n}"} for n in range(main.MAX_LIVE_FIELDS + 1)])
        assert response.status_code == 422
        assert "too many fields" in response.json()["detail"]

    def test_the_cap_itself_is_allowed(self, stub_llm) -> None:
        assert post([{"label": f"Question {n}"} for n in range(main.MAX_LIVE_FIELDS)]).status_code == 200


class TestLabelsAreScrubbed:
    """A label is written by the insurer, but rendered by a page that already
    holds the patient's data — so it can carry an identifier."""

    def test_an_identifier_in_a_label_does_not_reach_the_model(self, stub_llm) -> None:
        post([
            {"label": "Policy 80123456 — claim details"},
            {"label": "Confirm NRIC S9988776Z"},
            {"label": "Send a copy to weiming.tan@example.com"},
            {"label": "Call 9123 4567 to confirm"},
        ])
        sent = " ".join(f.description or "" for f in stub_llm["schema"].fields)
        for identifier in ("80123456", "S9988776Z", "weiming.tan@example.com", "9123 4567"):
            assert identifier not in sent

    def test_the_label_the_doctor_reads_is_scrubbed_too(self, stub_llm) -> None:
        rows = post([{"label": "Confirm NRIC S9988776Z"}]).json()["fields"]
        assert "S9988776Z" not in rows[0]["label"]

    def test_a_name_in_a_label_is_the_known_hole(self, stub_llm) -> None:
        # Not a passing guarantee — a demonstration, so nobody rediscovers it
        # by accident. The scrubber finds identifiers by shape and a name has
        # none. This is why prose is never read as a label, why option lists
        # are withheld whole, and why a schema beats this path.
        post([{"label": "Claim for Tan Wei Ming"}])
        assert "Tan Wei Ming" in (stub_llm["schema"].fields[0].description or "")

    def test_the_clinical_text_is_still_redacted(self, stub_llm) -> None:
        # The path changed; the pipeline did not.
        post(LIVE_FIELDS)
        assert "Tan Wei Ming" not in stub_llm["redacted_text"]
        assert "S1234567A" not in stub_llm["redacted_text"]
        assert "[PATIENT]" in stub_llm["redacted_text"]
