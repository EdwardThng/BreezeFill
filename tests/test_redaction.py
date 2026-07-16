"""Redaction must be bulletproof: golden set, round-trip, adversarial cases.

Over-redaction is acceptable; any identifier surviving redaction is a failure.
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

from fixtures.synthetic_notes import GOLDEN_NOTES
from redaction import PatientRecord, TOKEN_RE, redact, remerge


def make_record(**overrides) -> PatientRecord:
    base = {
        "full_name": "Tan Wei Ming",
        "nric": "S1234567A",
        "dob": "1962-03-14",
        "phone": "91234567",
        "address": "Blk 123 Bedok North Ave 4, #05-678",
        "policy_number": "GE-8839221",
        "insurer": "Great Eastern",
        "clinical_text": "",
    }
    base.update(overrides)
    return PatientRecord(**base)


# ---------------------------------------------------------------------------
# Golden set: zero identifiers survive
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "note", GOLDEN_NOTES, ids=[n["record"]["nric"] for n in GOLDEN_NOTES]
)
def test_golden_no_identifier_survives(note):
    record = PatientRecord(**note["record"])
    result = redact(record)
    redacted = result.redacted_text.lower()
    for identifier in note["identifiers_in_text"]:
        assert identifier.lower() not in redacted, (
            f"identifier {identifier!r} survived redaction"
        )


@pytest.mark.parametrize(
    "note", GOLDEN_NOTES, ids=[n["record"]["nric"] for n in GOLDEN_NOTES]
)
def test_golden_no_name_part_survives(note):
    record = PatientRecord(**note["record"])
    redacted = redact(record).redacted_text.lower()
    import re

    for part in record.full_name.split():
        if len(part) >= 3:
            assert not re.search(rf"\b{re.escape(part.lower())}\b", redacted), (
                f"name part {part!r} survived redaction"
            )


# ---------------------------------------------------------------------------
# Round-trip: redact -> remerge == input (canonical-form identifiers)
# ---------------------------------------------------------------------------


def test_round_trip_canonical():
    text = (
        "Tan Wei Ming (S1234567A), DOB 14/03/1962, contact 91234567, "
        "resides Blk 123 Bedok North Ave 4, #05-678. Policy GE-8839221. "
        "Dx: acute appendicitis, confirmed on CT 02/06/2026."
    )
    record = make_record(clinical_text=text)
    result = redact(record)
    merged, unresolved = remerge(result.redacted_text, result.redaction_map)
    assert merged == text
    assert unresolved == []


def test_remerge_expands_partial_name_to_full_name():
    # "Mr Tan" -> "[PATIENT]" -> re-merge yields the registered full name,
    # which is what the insurance form wants.
    record = make_record(clinical_text="Mr Tan reviewed today, well.")
    result = redact(record)
    merged, unresolved = remerge(result.redacted_text, result.redaction_map)
    assert "Mr Tan Wei Ming reviewed today" in merged
    assert unresolved == []


def test_remerge_flags_unresolved_tokens():
    merged, unresolved = remerge(
        "Patient [PATIENT] seen by [UNKNOWN_TOKEN].", {"[PATIENT]": "Tan Wei Ming"}
    )
    assert unresolved == ["[UNKNOWN_TOKEN]"]
    assert "[PATIENT]" not in merged


# ---------------------------------------------------------------------------
# Adversarial cases
# ---------------------------------------------------------------------------


def test_name_split_across_lines():
    record = make_record(clinical_text="Seen today: Tan\nWei Ming, stable.")
    redacted = redact(record).redacted_text
    assert "Tan" not in redacted and "Wei" not in redacted and "Ming" not in redacted
    assert "[PATIENT]" in redacted


def test_lowercase_name():
    record = make_record(clinical_text="pt tan wei ming attended f/u.")
    redacted = redact(record).redacted_text
    assert "tan" not in redacted.lower().replace("[patient]", "")
    assert "[PATIENT]" in redacted


def test_full_name_collapses_to_single_token():
    record = make_record(clinical_text="Tan Wei Ming seen today.")
    redacted = redact(record).redacted_text
    assert redacted.count("[PATIENT]") == 1


def test_nric_with_spaces():
    record = make_record(clinical_text="NRIC S 1234567 A on file.")
    redacted = redact(record).redacted_text
    assert "1234567" not in redacted
    assert "[NRIC]" in redacted


def test_surname_common_word_boundary():
    # Patient surnamed "Ang": the word "Ang" is redacted, but "angina" and
    # "angiogram" must survive — word-boundary matching.
    record = make_record(
        full_name="Ang Mei Ling",
        clinical_text="Mdm Ang c/o angina; angiogram booked. Ang stable.",
    )
    redacted = redact(record).redacted_text
    assert "angina" in redacted
    assert "angiogram" in redacted
    assert "Mdm [PATIENT]" in redacted


def test_two_char_surname_case_sensitive():
    # Surname "He": capitalized occurrences are redacted (accepting some
    # over-redaction at sentence starts), lowercase pronoun "he" survives.
    record = make_record(
        full_name="He Jun Jie",
        clinical_text="Mr He seen today; he reports the pain has resolved.",
    )
    redacted = redact(record).redacted_text
    assert "Mr [PATIENT]" in redacted
    assert "he reports the pain" in redacted


def test_phone_with_plus65_and_separators():
    record = make_record(
        phone="+65 9123 4567",
        clinical_text="Call 9123 4567 or +65 9123-4567 to confirm TCU.",
    )
    redacted = redact(record).redacted_text
    assert "9123" not in redacted and "4567" not in redacted


# ---------------------------------------------------------------------------
# Pass 2: identifiers NOT in the dictionary
# ---------------------------------------------------------------------------


def test_pass2_third_party_nric_phone_email():
    record = make_record(
        clinical_text=(
            "Accompanied by wife (S7654321B, HP 87654321, chua.w@example.com). "
            "Patient S1234567A stable."
        )
    )
    result = redact(record)
    redacted = result.redacted_text
    assert "S7654321B" not in redacted
    assert "87654321" not in redacted
    assert "chua.w@example.com" not in redacted
    # Third-party tokens are numbered after the patient's own.
    assert "[NRIC_2]" in redacted and "[PHONE_2]" in redacted and "[EMAIL_1]" in redacted
    assert result.redaction_map["[NRIC_2]"] == "S7654321B"
    # Patient's own NRIC still uses the primary token.
    assert "[NRIC]" in redacted


def test_pass2_repeated_value_gets_same_token():
    record = make_record(
        clinical_text="Sister at 87654321. Confirmed 87654321 again."
    )
    result = redact(record)
    assert result.redacted_text.count("[PHONE_2]") == 2
    assert "[PHONE_3]" not in result.redacted_text


# ---------------------------------------------------------------------------
# Pass 3: pluggable LLM sweep
# ---------------------------------------------------------------------------


def test_pass3_llm_sweep_tokenizes_findings():
    record = make_record(
        clinical_text="Seen previously by Dr Lim; his wife Mdm Chua present."
    )
    result = redact(record, llm_sweep=lambda text: ["Dr Lim", "Mdm Chua", "NONE"])
    assert "Dr Lim" not in result.redacted_text
    assert "Mdm Chua" not in result.redacted_text
    assert result.redaction_map["[REDACTED_1]"] == "Dr Lim"


def test_pass3_ignores_findings_not_in_text():
    record = make_record(clinical_text="Routine review, stable.")
    result = redact(record, llm_sweep=lambda text: ["Dr Phantom"])
    assert "[REDACTED_1]" not in result.redacted_text


# ---------------------------------------------------------------------------
# Hygiene: redaction map never leaks into redacted text
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "note", GOLDEN_NOTES, ids=[n["record"]["nric"] for n in GOLDEN_NOTES]
)
def test_redacted_text_only_contains_known_tokens(note):
    result = redact(PatientRecord(**note["record"]))
    for token in TOKEN_RE.findall(result.redacted_text):
        assert token in result.redaction_map, f"orphan token {token}"
