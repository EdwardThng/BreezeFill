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
    SYSTEM_PROMPT,
    FieldAnswer,
    FormSchema,
    MappingError,
    assemble_claim,
    build_output_schema,
    llm_sweep,
    load_form_schema,
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
    assert set(item["required"]) == {"id", "value", "status", "source", "reasoning"}
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
# Fields that declare their permitted answers
# ---------------------------------------------------------------------------
#
# The failure being guarded is a wizard dropdown: the model answers with
# wording the control does not offer, the value passes review, and the browser
# then finds no matching option and writes nothing. The doctor approved a value
# that was never written and sees a blank they did not choose.

OPTION_SCHEMA = FormSchema.model_validate(
    {
        "form_id": "options_v1",
        "fill_mode": "web",
        "fields": [
            {
                "id": "ward_class",
                "type": "text",
                "source": "llm",
                "description": "Ward class the patient was admitted to",
                "options": ["A1 (single)", "B1 (4-bedded)", "C (open)"],
            },
            {
                "id": "diagnosis",
                "type": "text",
                "source": "llm",
                "description": "Primary diagnosis",
            },
        ],
    }
)


def option_answers(value: str, field_id: str = "ward_class"):
    reply = {"fields": [{"id": field_id, "value": value, "status": "extracted", "source": "s"}]}
    return map_fields(OPTION_SCHEMA, "notes", client=FakeClient(json.dumps(reply)))


def test_declared_options_reach_the_model():
    client = FakeClient(json.dumps({"fields": []}))
    map_fields(OPTION_SCHEMA, "notes", client=client)
    prompt = client.last_kwargs["messages"][0]["content"]
    assert "B1 (4-bedded)" in prompt
    # A field with no options must not advertise an empty list: "options": []
    # reads as "accepts nothing" rather than "accepts free text".
    field_lines = json.loads(prompt.split("Form fields to fill:\n")[1].split("\n\n")[0])
    by_id = {f["id"]: f for f in field_lines}
    assert by_id["ward_class"]["options"] == ["A1 (single)", "B1 (4-bedded)", "C (open)"]
    assert "options" not in by_id["diagnosis"]


def test_an_answer_on_the_list_survives():
    assert option_answers("B1 (4-bedded)").get("ward_class").value == "B1 (4-bedded)"


def test_case_and_spacing_are_forgiven_and_the_form_wording_wins():
    # What gets written must be a string the control actually offers, because
    # the browser matches option text exactly. So the form's rendering of the
    # option replaces the model's.
    answer = option_answers("b1  (4-BEDDED)").get("ward_class")
    assert answer.value == "B1 (4-bedded)"
    assert answer.status == "extracted"


def test_an_answer_off_the_list_is_missing_not_the_nearest_option():
    # "Ward B1" is obviously meant to be "B1 (4-bedded)" and is still refused.
    # Snapping it across would be a guess at what the doctor is about to sign,
    # made by string distance, and review cannot see it happen.
    answer = option_answers("Ward B1").get("ward_class")
    assert answer.status == "missing"
    assert answer.value is None


def test_options_do_not_constrain_the_fields_without_them():
    reply = {"fields": [{"id": "diagnosis", "value": "Dengue fever", "status": "extracted", "source": "s"}]}
    answers = map_fields(OPTION_SCHEMA, "notes", client=FakeClient(json.dumps(reply)))
    assert answers["diagnosis"].value == "Dengue fever"


def test_options_never_reach_the_output_grammar():
    # The guarantee is enforced after parsing, deliberately. A per-field enum
    # means per-field properties, which is the shape that blows the grammar
    # limits on a real 24-field form.
    schema = build_output_schema(OPTION_SCHEMA.llm_fields)
    assert "B1 (4-bedded)" not in json.dumps(schema)


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
# Dates are always re-read by the doctor
# ---------------------------------------------------------------------------
#
# The status enum answers "did the notes say this", and for a date that is the
# wrong question: the notes can state 03/07 perfectly clearly and still not say
# whether it means 3 July or 7 March. No amount of care in the model or the
# prompt closes that, so the row goes back to a human.
#
# Only where both readings exist, though. A day over 12 cannot be a month, so
# 25/07 says one thing to everybody and is left alone — the boundary is what
# keeps the click meaningful on a form with 22 date fields.


def test_an_extracted_date_still_needs_review():
    answers = {
        "date_first_consult": FieldAnswer(
            value="03/07/2026", status="extracted", source="First seen 03/07/2026"
        ),
        "diagnosis_primary": FieldAnswer(
            value="Acute appendicitis", status="extracted", source="Dx: appendicitis"
        ),
    }
    by_id = {r.field_id: r for r in assemble_claim(SAMPLE_SCHEMA, make_record(), answers, {})}

    date_row = by_id["date_first_consult"]
    assert date_row.status == "extracted"
    assert date_row.needs_review is True
    assert date_row.recheck is not None

    # ...and this is a date rule, not a new blanket distrust of `extracted`.
    # Text the notes stated outright is still written without a click; making
    # everything need confirming is how confirming stops meaning anything.
    assert by_id["diagnosis_primary"].needs_review is False
    assert by_id["diagnosis_primary"].recheck is None


def test_a_demographic_date_needs_review_but_other_demographics_do_not():
    """The DOB is assigned by pattern, day-first, with no model and no source
    snippet to check it against — so it is the *least* verified date in the
    claim, not the most."""
    record = make_record(dob=date(1962, 3, 4))  # 04/03/1962 — could be 3 April
    by_id = {r.field_id: r for r in assemble_claim(SAMPLE_SCHEMA, record, {}, {})}

    assert by_id["patient_dob"].status == "demographic"
    assert by_id["patient_dob"].needs_review is True
    assert by_id["patient_dob"].recheck is not None

    assert by_id["patient_name"].needs_review is False
    assert by_id["patient_name"].recheck is None


def test_a_day_over_twelve_reads_the_same_to_everyone_and_is_not_held():
    """There is no 25th month, so 25/07 says one thing however the writer
    thinks about date order. Asking the doctor to confirm it is asking them to
    check something with one answer, and a confirm click that is never the
    interesting one is how the ones that are get skimmed past."""
    answers = {
        "date_first_consult": FieldAnswer(
            value="25/07/2026", status="extracted", source="First seen 25/07/2026"
        )
    }
    # ...and the same for a demographic date: 14/03/1962 is unambiguous too.
    by_id = {
        r.field_id: r
        for r in assemble_claim(SAMPLE_SCHEMA, make_record(), answers, {})
    }

    assert by_id["date_first_consult"].needs_review is False
    assert by_id["date_first_consult"].recheck is None
    assert by_id["patient_dob"].value == "14/03/1962"
    assert by_id["patient_dob"].needs_review is False


def test_a_month_over_twelve_is_held_because_it_was_written_the_wrong_way_round():
    """03/25 is not ambiguous — but it is worse than ambiguous. It was written
    month-first and the form will read it day-first, so the message the row
    carries is exactly right."""
    answers = {
        "date_first_consult": FieldAnswer(value="03/25/2026", status="extracted", source="s")
    }
    row = {r.field_id: r for r in assemble_claim(SAMPLE_SCHEMA, make_record(), answers, {})}[
        "date_first_consult"
    ]
    assert row.needs_review is True
    assert row.recheck is not None


def test_a_date_that_is_not_a_slash_date_carries_no_recheck_sentence():
    """The sentence talks about the day and month being swapped. On a value
    with no day and month to swap it would be describing nothing, so the row
    keeps whatever review its status earned instead."""
    answers = {
        "date_first_consult": FieldAnswer(
            value="July 2026", status="inferred", source="admitted in July"
        )
    }
    row = {r.field_id: r for r in assemble_claim(SAMPLE_SCHEMA, make_record(), answers, {})}[
        "date_first_consult"
    ]
    assert row.recheck is None
    assert row.needs_review is True  # still held, because it was inferred


def test_a_date_with_no_value_is_not_held_for_rechecking():
    """A blank is written by hand whatever we say about it. Holding it would
    ask the doctor to confirm nothing — 22 times on the AIA medical report."""
    answers = {"date_first_consult": FieldAnswer(value=None, status="missing", source=None)}
    row = {r.field_id: r for r in assemble_claim(SAMPLE_SCHEMA, make_record(), answers, {})}[
        "date_first_consult"
    ]
    assert row.recheck is None
    # Still held, but for the reason it always was: there is nothing there.
    assert row.needs_review is True


def test_recheck_never_lowers_the_bar_on_a_row_already_held():
    """An unresolved token blanks the value, so no recheck reason attaches —
    and the row must keep the review flag its status earned."""
    answers = {
        "date_first_consult": FieldAnswer(
            value="[REDACTED_9]", status="extracted", source="s"
        )
    }
    row = {r.field_id: r for r in assemble_claim(SAMPLE_SCHEMA, make_record(), answers, {})}[
        "date_first_consult"
    ]
    assert row.value is None
    assert row.needs_review is True
    assert row.recheck is None


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


# ---------------------------------------------------------------------------
# Date format: the field's boxes, not a global rule
# ---------------------------------------------------------------------------
#
# Regression for a real production run against aia_ghs_claim on 2026-08-05,
# which returned 14/03/26 in two date boxes and 14/03/2026 in two others. Every
# date description in that schema asks for DD/MM/YY while SYSTEM_PROMPT
# mandated DD/MM/YYYY, so the model had two instructions and split the
# difference.

DATE_SCHEMA = FormSchema.model_validate(
    {
        "form_id": "dates_v1",
        "fill_mode": "web",
        "fields": [
            {
                "id": "short_year",
                "type": "date",
                "source": "llm",
                "description": "Date of surgical procedure (DD/MM/YY)",
            },
            {
                "id": "long_year",
                "type": "date",
                "source": "llm",
                "description": "Date of admission (DD/MM/YYYY)",
            },
            {
                "id": "unstated",
                "type": "date",
                "source": "llm",
                "description": "Date the patient was discharged",
            },
        ],
    }
)


def date_answer(field_id: str, value: str):
    reply = {"fields": [{"id": field_id, "value": value, "status": "extracted", "source": "s"}]}
    return map_fields(DATE_SCHEMA, "notes", client=FakeClient(json.dumps(reply)))[field_id]


def test_the_prompt_lets_a_field_override_the_date_format():
    # Guards the half of the fix that is instruction rather than code. An
    # absolute "dates must be DD/MM/YYYY" is what caused the split.
    assert "unless the field's own description states a different" in SYSTEM_PROMPT


def test_a_field_asking_for_a_short_year_gets_one():
    # The exact production failure: the model answered in full-year form for a
    # field whose box holds two digits.
    assert date_answer("short_year", "15/03/2026").value == "15/03/26"


def test_a_short_year_is_never_expanded_into_a_century():
    # 26 is 2026 or 1926 depending on which box it sits in, and a claim form
    # carries dates of birth as readily as dates of admission. The answer is
    # left as the model wrote it and reaches the doctor in review.
    assert date_answer("long_year", "15/03/26").value == "15/03/26"


def test_a_field_that_states_no_format_is_left_alone():
    assert date_answer("unstated", "15/03/2026").value == "15/03/2026"


def test_reformatting_never_invents_or_drops_an_answer():
    # Formatting is not validation: a date that does not parse is still the
    # doctor's answer to correct, not something to silently blank.
    answer = date_answer("short_year", "mid-March 2026")
    assert answer.value == "mid-March 2026"
    assert answer.status == "extracted"


def test_the_aia_schema_and_the_prompt_no_longer_disagree():
    # The schema that produced the bug, checked against the rule that fixes it:
    # every date-typed field states its format, so nothing falls back to the
    # global default by accident.
    schema = load_form_schema(Path(__file__).parent.parent / "backend" / "schemas" / "aia_ghs_claim.json")
    dated = [f for f in schema.fields if f.type == "date"]
    assert dated, "expected date fields on the AIA form"
    for field in dated:
        assert "DD/MM/YY" in (field.description or ""), f"{field.id} states no date format"


# ---------------------------------------------------------------------------
# Options win over type
# ---------------------------------------------------------------------------
#
# `_coerce_answer` used to check `field.type == "checkbox"` first and demand
# "true"/"false", which made `options` unreachable on a checkbox field: the
# model answered with the option's own wording and every answer collapsed to
# missing. That is the common insurer shape — a question answered by ticking
# one box out of several, where the answer is the box's wording, not a boolean.

CHECKBOX_OPTION_SCHEMA = FormSchema.model_validate(
    {
        "form_id": "checkbox_options_v1",
        "fill_mode": "web",
        "fields": [
            {
                "id": "admission_type",
                "type": "checkbox",
                "source": "llm",
                "description": "How the patient was admitted",
                "options": ["Emergency", "Elective", "Day surgery"],
            },
            {
                "id": "consent_given",
                "type": "checkbox",
                "source": "llm",
                "description": "Whether the patient consented",
            },
        ],
    }
)


def _checkbox_answer(field_id: str, value: str):
    reply = {"fields": [{"id": field_id, "value": value, "status": "extracted", "source": "s"}]}
    return map_fields(
        CHECKBOX_OPTION_SCHEMA, "notes", client=FakeClient(json.dumps(reply))
    )[field_id]


def test_a_checkbox_field_with_options_is_answered_with_an_option():
    answer = _checkbox_answer("admission_type", "Emergency")
    assert answer.status == "extracted"
    assert answer.value == "Emergency"


def test_a_checkbox_option_keeps_the_forms_own_wording():
    # Case and surrounding space are forgiven; what survives is the string the
    # control actually offers, because that is what applyOption matches on.
    assert _checkbox_answer("admission_type", "  day SURGERY ").value == "Day surgery"


def test_an_off_list_checkbox_answer_is_missing_not_a_boolean():
    answer = _checkbox_answer("admission_type", "true")
    assert answer.status == "missing"
    assert answer.value is None


def test_a_checkbox_without_options_is_still_a_boolean():
    # The old behaviour has to survive for a plain tick box, which is what a
    # lone named checkbox still is.
    assert _checkbox_answer("consent_given", "true").value is True
    assert _checkbox_answer("consent_given", "false").value is False
    assert _checkbox_answer("consent_given", "Emergency").status == "missing"


# ---------------------------------------------------------------------------
# The insurer comes from the form, not from the note
# ---------------------------------------------------------------------------
#
# `parse_demographics` can only find an insurer the note labelled, and a note
# usually names it in passing if at all — "(AIA Singapore)" after the policy
# number. But the insurer that belongs on the form is the one whose form it
# is, which the schema already knows. Reading it out of the note is a
# roundabout route to an answer we hold, and a wrong one whenever the note
# names a different insurer than the form being filled.

INSURER_SCHEMA = FormSchema.model_validate(
    {
        "form_id": "insurer_probe_v1",
        "pdf_path": "forms/dev_sample.pdf",
        "insurer": "AIA",
        "fields": [
            {
                "id": "insurer_name",
                "pdf_field_name": "Text_Insurer",
                "type": "text",
                "source": "demographics.insurer",
            },
        ],
    }
)


def test_the_insurer_comes_from_the_form_when_the_note_did_not_name_one():
    record = make_record(insurer="")
    [row] = assemble_claim(INSURER_SCHEMA, record, {}, {})

    assert row.value == "AIA"
    assert row.status == "demographic"


def test_a_doctor_entered_insurer_is_not_overwritten_by_the_form():
    # The refusal that matters. The doctor typed it, so it wins — the schema
    # value is a fallback for a blank box, never a correction of an answer a
    # human already gave.
    record = make_record(insurer="Great Eastern")
    [row] = assemble_claim(INSURER_SCHEMA, record, {}, {})

    assert row.value == "Great Eastern"


def test_a_form_with_no_insurer_of_its_own_leaves_the_box_blank():
    # The live path: a schema synthesised from the page's own controls carries
    # no insurer, so there is nothing to fall back to. Blank is the correct
    # answer, and the doctor types one line.
    schema = INSURER_SCHEMA.model_copy(update={"insurer": None})
    [row] = assemble_claim(schema, make_record(insurer=""), {}, {})

    assert not row.value


# ---------------------------------------------------------------------------
# The citation, and why an inference is not one
# ---------------------------------------------------------------------------
#
# `source` is the sentence the model is told to quote verbatim, and the panel
# marks it in the note beside the value. Two things were wrong with it.
#
# It was quoted out of the REDACTED note and handed back untouched, so any
# sentence carrying an identifier came back as "[PATIENT] seen 02/08" and
# could never be found in the doctor's own paste — the citation silently
# failed on exactly the sentences that name the patient.
#
# And an inferred value is not IN its sentence. "J03.90" appears nowhere in
# "Dx acute tonsillitis." Marking the two the same way makes the inference —
# the most dangerous value on the screen, and the one the doctor is about to
# sign — read as a wrong citation. `reasoning` is what closes that.


def test_the_quoted_sentence_is_remerged_like_the_value():
    # Without this the pane searches the doctor's paste for a sentence that
    # only ever existed in the redacted copy, and finds nothing.
    answers = {
        "diagnosis_primary": FieldAnswer(
            value="Acute tonsillitis",
            status="extracted",
            source="[REDACTED_1] seen 02/08. Dx acute tonsillitis.",
        )
    }
    rows = assemble_claim(
        SAMPLE_SCHEMA, make_record(), answers, {"[REDACTED_1]": "Tan Wei Ling"}
    )
    row = {r.field_id: r for r in rows}["diagnosis_primary"]

    assert row.source == "Tan Wei Ling seen 02/08. Dx acute tonsillitis."


def test_a_quote_with_a_token_nothing_resolves_is_dropped_not_shown():
    # A raw [TOKEN] in the pane is worse than no citation: it is a citation
    # the doctor cannot check, rendered exactly like one they can.
    answers = {
        "diagnosis_primary": FieldAnswer(
            value="Acute tonsillitis", status="extracted", source="[REDACTED_9] seen 02/08."
        )
    }
    rows = assemble_claim(SAMPLE_SCHEMA, make_record(), answers, {})
    row = {r.field_id: r for r in rows}["diagnosis_primary"]

    assert row.source is None
    # The VALUE is untouched — it carried no token, so it is still answerable.
    assert row.value == "Acute tonsillitis"


def test_an_inferred_value_carries_the_reasoning_that_produced_it():
    answers = {
        "diagnosis_primary": FieldAnswer(
            value="J03.90",
            status="inferred",
            source="Dx acute tonsillitis.",
            reasoning="J03.90 is the ICD-10 code for acute tonsillitis.",
        )
    }
    rows = assemble_claim(SAMPLE_SCHEMA, make_record(), answers, {})
    row = {r.field_id: r for r in rows}["diagnosis_primary"]

    assert row.reasoning == "J03.90 is the ICD-10 code for acute tonsillitis."


def test_only_an_inference_carries_reasoning():
    # An extracted value is in the sentence it quotes, so a sentence
    # explaining it is noise at best — and at worst it is the model
    # rationalising a value it read straight off the page.
    answers = {
        "diagnosis_primary": FieldAnswer(
            value="Acute tonsillitis",
            status="extracted",
            source="Dx acute tonsillitis.",
            reasoning="The note states the diagnosis.",
        )
    }
    rows = assemble_claim(SAMPLE_SCHEMA, make_record(), answers, {})

    assert {r.field_id: r for r in rows}["diagnosis_primary"].reasoning is None


def test_reasoning_is_remerged_and_dropped_when_a_token_survives():
    answers = {
        "diagnosis_primary": FieldAnswer(
            value="J03.90", status="inferred", source="Dx acute tonsillitis.",
            reasoning="[REDACTED_9] was coded from the diagnosis.",
        )
    }
    rows = assemble_claim(SAMPLE_SCHEMA, make_record(), answers, {})

    assert {r.field_id: r for r in rows}["diagnosis_primary"].reasoning is None


def test_reasoning_never_reaches_the_output_grammar_as_a_union():
    # The grammar limits are unforgiving and this adds a property to every
    # item. It must stay a plain string like the rest.
    fields = [f for f in SAMPLE_SCHEMA.fields if f.source == "llm"]
    item = build_output_schema(fields)["properties"]["fields"]["items"]

    assert item["properties"]["reasoning"] == {"type": "string"}
    assert "reasoning" in item["required"]
