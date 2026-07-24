"""Mapping-layer tests. All offline: LLM calls go through a stub client.

Covers: structured-output schema shape, answer validation (malformed ->
missing, never a crash), refusal/truncation errors, sweep-reply parsing,
and claim assembly (demographics copy, re-merge, unresolved-token blanking,
review flags).
"""

import json
import sys
from datetime import date
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).parent))

from mapping import (
    FieldAnswer,
    FormSchema,
    MappingError,
    assemble_claim,
    build_output_schema,
    llm_sweep,
    map_fields,
)
from redaction import PatientRecord, redact

SAMPLE_SCHEMA = FormSchema.model_validate(
    {
        "form_id": "dev_sample_v1",
        "pdf_path": "forms/dev_sample.pdf",
        "fields": [
            {
                "id": "patient_name",
                "pdf_field_name": "Text_PatientName",
                "type": "text",
                "source": "demographics.full_name",
            },
            {
                "id": "patient_dob",
                "pdf_field_name": "Text_DOB",
                "type": "date",
                "source": "demographics.dob",
            },
            {
                "id": "diagnosis_primary",
                "pdf_field_name": "Text_Diagnosis1",
                "type": "text",
                "source": "llm",
                "description": "Primary diagnosis for this claim",
            },
            {
                "id": "date_first_consult",
                "pdf_field_name": "Date_FirstConsult",
                "type": "date",
                "source": "llm",
                "description": "Date the patient FIRST consulted for this condition",
            },
            {
                "id": "symptoms_preexisting",
                "pdf_field_name": "Check_PreExisting",
                "type": "checkbox",
                "source": "llm",
                "description": "Pre-existing condition per the notes?",
            },
        ],
    }
)


class FakeClient:
    """Stub for anthropic.Anthropic: records the request, returns a canned
    response."""

    def __init__(self, text: str, stop_reason: str = "end_turn"):
        self.last_kwargs = None
        self._response = SimpleNamespace(
            stop_reason=stop_reason,
            content=[SimpleNamespace(type="text", text=text)],
        )
        self.messages = SimpleNamespace(create=self._create)

    def _create(self, **kwargs):
        self.last_kwargs = kwargs
        return self._response


def make_record(**overrides) -> PatientRecord:
    base = {
        "full_name": "Tan Wei Ming",
        "nric": "S1234567A",
        "dob": date(1962, 3, 14),
        "insurer": "Great Eastern",
        "clinical_text": "First seen 02/06/2026 c/o RIF pain. Dx: acute appendicitis.",
    }
    base.update(overrides)
    return PatientRecord(**base)


GOOD_LLM_JSON = json.dumps(
    {
        "fields": [
            {
                "id": "diagnosis_primary",
                "value": "Acute appendicitis",
                "status": "extracted",
                "source": "Dx: acute appendicitis",
            },
            {
                "id": "date_first_consult",
                "value": "02/06/2026",
                "status": "extracted",
                "source": "First seen 02/06/2026",
            },
            {
                "id": "symptoms_preexisting",
                "value": "false",
                "status": "inferred",
                "source": "acute onset",
            },
        ]
    }
)


# ---------------------------------------------------------------------------
# Output schema
# ---------------------------------------------------------------------------


def test_output_schema_covers_llm_fields_only():
    schema = build_output_schema(SAMPLE_SCHEMA.llm_fields)
    item = schema["properties"]["fields"]["items"]
    assert set(item["properties"]["id"]["enum"]) == {
        "diagnosis_primary", "date_first_consult", "symptoms_preexisting",
    }
    assert item["additionalProperties"] is False
    assert set(item["required"]) == {"id", "value", "status", "source"}
    # Values are always strings; checkbox booleans travel as "true"/"false".
    assert item["properties"]["value"] == {"type": "string"}


def test_output_schema_has_no_union_types():
    # The structured-output API rejects schemas with >16 union-typed
    # parameters; a real form has 20+ fields, so no anyOf/type-arrays at all.
    schema = build_output_schema(SAMPLE_SCHEMA.llm_fields)

    def walk(node):
        if isinstance(node, dict):
            assert "anyOf" not in node
            assert not isinstance(node.get("type"), list)
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    walk(schema)


def test_map_fields_normalizes_empty_string_to_missing():
    # "" is the no-answer sentinel (schema forbids nulls) — it must come back
    # as a clean missing answer, never an empty value on the form.
    reply = {
        "fields": [
            {"id": "diagnosis_primary", "value": "", "status": "extracted", "source": ""},
            {"id": "date_first_consult", "value": "01/07/2026", "status": "extracted", "source": ""},
            {"id": "symptoms_preexisting", "value": "false", "status": "missing", "source": ""},
        ]
    }
    client = FakeClient(json.dumps(reply))
    answers = map_fields(SAMPLE_SCHEMA, "redacted notes", client=client)
    assert answers["diagnosis_primary"].value is None
    assert answers["diagnosis_primary"].status == "missing"
    assert answers["date_first_consult"].value == "01/07/2026"
    assert answers["date_first_consult"].source is None
    assert answers["symptoms_preexisting"].value is None
    assert answers["symptoms_preexisting"].status == "missing"


def test_map_fields_checkbox_string_coercion():
    reply = {
        "fields": [
            {"id": "symptoms_preexisting", "value": "True", "status": "extracted", "source": "s"},
        ]
    }
    answers = map_fields(SAMPLE_SCHEMA, "notes", client=FakeClient(json.dumps(reply)))
    assert answers["symptoms_preexisting"].value is True
    # Non-boolean text in a checkbox field is a malformed answer -> missing.
    reply["fields"][0]["value"] = "probably"
    answers = map_fields(SAMPLE_SCHEMA, "notes", client=FakeClient(json.dumps(reply)))
    assert answers["symptoms_preexisting"].status == "missing"


# ---------------------------------------------------------------------------
# map_fields
# ---------------------------------------------------------------------------


def test_map_fields_parses_valid_response():
    client = FakeClient(GOOD_LLM_JSON)
    answers = map_fields(SAMPLE_SCHEMA, "redacted notes", client=client)
    assert answers["diagnosis_primary"].value == "Acute appendicitis"
    assert answers["diagnosis_primary"].status == "extracted"
    assert answers["symptoms_preexisting"].value is False


def test_map_fields_sends_only_redacted_text_and_llm_fields():
    client = FakeClient(GOOD_LLM_JSON)
    map_fields(SAMPLE_SCHEMA, "notes about [PATIENT]", client=client)
    prompt = client.last_kwargs["messages"][0]["content"]
    assert "notes about [PATIENT]" in prompt
    assert "diagnosis_primary" in prompt
    # Demographics fields never go to the LLM.
    assert "patient_name" not in prompt
    assert "full_name" not in prompt


def test_map_fields_malformed_field_becomes_missing():
    bad = json.dumps(
        {
            "fields": [
                {"id": "diagnosis_primary", "value": "X", "status": "not_a_status", "source": None},
                {"id": "date_first_consult", "value": "02/06/2026", "status": "extracted", "source": "s"},
                # symptoms_preexisting omitted entirely
            ]
        }
    )
    answers = map_fields(SAMPLE_SCHEMA, "notes", client=FakeClient(bad))
    assert answers["diagnosis_primary"].status == "missing"
    assert answers["symptoms_preexisting"].status == "missing"
    assert answers["date_first_consult"].status == "extracted"


def test_map_fields_refusal_raises():
    with pytest.raises(MappingError):
        map_fields(SAMPLE_SCHEMA, "notes", client=FakeClient("", stop_reason="refusal"))


def test_map_fields_truncation_raises():
    with pytest.raises(MappingError):
        map_fields(SAMPLE_SCHEMA, "notes", client=FakeClient("{", stop_reason="max_tokens"))


def test_map_fields_invalid_json_raises():
    with pytest.raises(MappingError):
        map_fields(SAMPLE_SCHEMA, "notes", client=FakeClient("not json"))


# ---------------------------------------------------------------------------
# llm_sweep reply parsing
# ---------------------------------------------------------------------------


def test_sweep_none_reply():
    assert llm_sweep("clean text", client=FakeClient("NONE")) == []
    assert llm_sweep("clean text", client=FakeClient("  none\n")) == []


def test_sweep_findings_parsed_line_by_line():
    reply = "- Dr Lim\n- Mdm Chua\nNONE"
    assert llm_sweep("text", client=FakeClient(reply)) == ["Dr Lim", "Mdm Chua"]


# ---------------------------------------------------------------------------
# assemble_claim
# ---------------------------------------------------------------------------


def test_assemble_demographics_direct_copy():
    rows = assemble_claim(SAMPLE_SCHEMA, make_record(), {}, {})
    by_id = {r.field_id: r for r in rows}
    assert by_id["patient_name"].value == "Tan Wei Ming"
    assert by_id["patient_name"].status == "demographic"
    assert by_id["patient_name"].needs_review is False
    assert by_id["patient_dob"].value == "14/03/1962"


def test_assemble_remerges_tokens_in_values():
    answers = {
        "diagnosis_primary": FieldAnswer(
            value="[PATIENT] has acute appendicitis", status="extracted", source="s"
        )
    }
    rows = assemble_claim(
        SAMPLE_SCHEMA, make_record(), answers, {"[PATIENT]": "Tan Wei Ming"}
    )
    by_id = {r.field_id: r for r in rows}
    assert by_id["diagnosis_primary"].value == "Tan Wei Ming has acute appendicitis"
    assert by_id["diagnosis_primary"].needs_review is False


def test_assemble_unresolved_token_blanks_value_and_flags_review():
    answers = {
        "diagnosis_primary": FieldAnswer(
            value="seen by [REDACTED_9]", status="extracted", source="s"
        )
    }
    rows = assemble_claim(SAMPLE_SCHEMA, make_record(), answers, {})
    row = {r.field_id: r for r in rows}["diagnosis_primary"]
    assert row.value is None
    assert row.status == "missing"
    assert row.needs_review is True


def test_assemble_non_extracted_statuses_need_review():
    answers = {
        "symptoms_preexisting": FieldAnswer(value=False, status="inferred", source="s"),
    }
    rows = assemble_claim(SAMPLE_SCHEMA, make_record(), answers, {})
    by_id = {r.field_id: r for r in rows}
    assert by_id["symptoms_preexisting"].needs_review is True
    # Field with no answer at all -> missing + review.
    assert by_id["date_first_consult"].status == "missing"
    assert by_id["date_first_consult"].needs_review is True


# ---------------------------------------------------------------------------
# End-to-end (offline): redact -> map (stub) -> assemble
# ---------------------------------------------------------------------------


def test_end_to_end_pipeline_offline():
    record = make_record(
        clinical_text=(
            "Mr Tan Wei Ming (S1234567A) first seen 02/06/2026 c/o RIF pain. "
            "Dx: acute appendicitis, confirmed on CT."
        )
    )
    result = redact(record)
    assert "Tan" not in result.redacted_text

    client = FakeClient(GOOD_LLM_JSON)
    answers = map_fields(SAMPLE_SCHEMA, result.redacted_text, client=client)
    # The prompt that would reach the API must contain no identifiers.
    prompt = client.last_kwargs["messages"][0]["content"]
    for identifier in ("Tan Wei Ming", "S1234567A", "14/03/1962"):
        assert identifier not in prompt

    rows = assemble_claim(SAMPLE_SCHEMA, record, answers, result.redaction_map)
    by_id = {r.field_id: r for r in rows}
    assert by_id["patient_name"].value == "Tan Wei Ming"
    assert by_id["diagnosis_primary"].value == "Acute appendicitis"
    assert by_id["symptoms_preexisting"].needs_review is True
