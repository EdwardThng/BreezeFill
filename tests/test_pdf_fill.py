"""PDF fill tests against the committed synthetic form (forms/dev_sample.pdf,
regenerable via scripts/make_dev_form.py)."""

import sys
from pathlib import Path

import pytest
from pypdf import PdfReader

sys.path.insert(0, str(Path(__file__).parent))

from pdf_fill import PdfFillError, dump_pdf_fields, fill_pdf

REPO_ROOT = Path(__file__).resolve().parent.parent
DEV_PDF = REPO_ROOT / "forms" / "dev_sample.pdf"


def read_back(pdf_bytes: bytes) -> dict:
    import io

    return PdfReader(io.BytesIO(pdf_bytes)).get_fields()


def test_dump_lists_expected_fields():
    fields = {f["name"]: f for f in dump_pdf_fields(DEV_PDF)}
    assert set(fields) == {
        "Text_PatientName", "Text_DOB", "Text_Diagnosis1",
        "Date_FirstConsult", "Check_PreExisting",
    }
    assert fields["Check_PreExisting"]["type"] == "/Btn"
    assert "/Off" in fields["Check_PreExisting"]["states"]


def test_fill_text_and_checkbox_true():
    pdf_bytes = fill_pdf(
        DEV_PDF,
        {
            "Text_PatientName": "Tan Wei Ming",
            "Text_DOB": "14/03/1962",
            "Text_Diagnosis1": "Acute appendicitis",
            "Date_FirstConsult": "02/06/2026",
            "Check_PreExisting": True,
        },
    )
    fields = read_back(pdf_bytes)
    assert fields["Text_PatientName"]["/V"] == "Tan Wei Ming"
    assert fields["Text_Diagnosis1"]["/V"] == "Acute appendicitis"
    assert fields["Check_PreExisting"]["/V"] == "/Yes"


def test_fill_checkbox_false_and_none_blank():
    pdf_bytes = fill_pdf(
        DEV_PDF,
        {
            "Text_PatientName": "Tan Wei Ming",
            "Text_Diagnosis1": None,  # left blank
            "Check_PreExisting": False,
        },
    )
    fields = read_back(pdf_bytes)
    assert fields["Check_PreExisting"]["/V"] == "/Off"
    assert not fields["Text_Diagnosis1"].get("/V")


def test_unknown_field_is_loud():
    with pytest.raises(PdfFillError, match="unknown fields"):
        fill_pdf(DEV_PDF, {"Text_DoesNotExist": "x"})


def test_unresolved_token_rejected():
    with pytest.raises(PdfFillError, match="unresolved redaction token"):
        fill_pdf(DEV_PDF, {"Text_Diagnosis1": "seen by [REDACTED_1]"})


def test_type_mismatches_rejected():
    with pytest.raises(PdfFillError, match="expected a boolean"):
        fill_pdf(DEV_PDF, {"Check_PreExisting": "yes"})
    with pytest.raises(PdfFillError, match="not a checkbox"):
        fill_pdf(DEV_PDF, {"Text_DOB": True})


def test_comb_fields_flattened_when_filled():
    # Great Eastern's official form uses comb (letter-per-cell) fields whose
    # cell counts are shorter than real values, so viewers clip the value to
    # a tail. Filled text fields must lose comb + scroll-lock + /MaxLen;
    # untouched fields keep theirs.
    import io

    ge_pdf = REPO_ROOT / "forms" / "ge_ghs_claim.pdf"
    comb = 1 << 24
    do_not_scroll = 1 << 23

    def raw_field(reader, name):
        for page in reader.pages:
            for ref in page.get("/Annots") or []:
                obj = ref.get_object()
                if str(obj.get("/T")) == name:
                    return obj
        raise AssertionError(f"field {name!r} not found")

    before = raw_field(PdfReader(str(ge_pdf)), "1a Patients Full Name")
    assert int(before.get("/Ff") or 0) & comb, "fixture no longer comb-flagged"
    assert before.get("/MaxLen") is not None

    pdf_bytes = fill_pdf(ge_pdf, {"1a Patients Full Name": "Tan Wei Ming"})
    filled_reader = PdfReader(io.BytesIO(pdf_bytes))
    filled = raw_field(filled_reader, "1a Patients Full Name")
    assert filled["/V"] == "Tan Wei Ming"
    assert int(filled.get("/Ff") or 0) & (comb | do_not_scroll) == 0
    assert filled.get("/MaxLen") is None
    untouched = raw_field(filled_reader, "1b NRICPPBC No")
    assert int(untouched.get("/Ff") or 0) & comb


def test_missing_pdf_is_loud():
    with pytest.raises(PdfFillError, match="not found"):
        fill_pdf(REPO_ROOT / "forms" / "nope.pdf", {})
