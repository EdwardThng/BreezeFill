"""API tests: map a note onto a form, then fill the PDF — with the LLM stubbed
out. Uses the committed dev_sample form + PDF.

The flow is two independent requests and the server remembers nothing between
them. `POST /map` returns the review rows, the client holds them while the
doctor edits, and `POST /forms/{id}/pdf` turns final values into a PDF. There
is no claim id in either direction, which is what lets this run on more than
one machine — or on a host that gives you a different process per request.
"""

import io
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pypdf import PdfReader

sys.path.insert(0, str(Path(__file__).parent))

import main
from mapping import FieldAnswer

client = TestClient(main.app)

FORM = "dev_sample_v1"
PDF_URL = f"/forms/{FORM}/pdf"

PATIENT = {
    "full_name": "Tan Wei Ming",
    "nric": "S1234567A",
    "dob": "1962-03-14",
    "phone": "91234567",
    "insurer": "Great Eastern",
    "clinical_text": (
        "Mr Tan Wei Ming (S1234567A) first seen 02/06/2026 c/o RIF pain. "
        "Dx: acute appendicitis, confirmed on CT. Contact 91234567."
    ),
}

GOOD_ANSWERS = {
    "diagnosis_primary": FieldAnswer(
        value="Acute appendicitis", status="extracted", source="Dx: acute appendicitis"
    ),
    "date_first_consult": FieldAnswer(
        value="02/06/2026", status="extracted", source="first seen 02/06/2026"
    ),
    "symptoms_preexisting": FieldAnswer(value=False, status="inferred", source="acute onset"),
}


@pytest.fixture(autouse=True)
def stub_llm(monkeypatch):
    """No real LLM calls in tests; capture what would have been sent."""
    sent = {}

    def fake_map_fields(schema, redacted_text, client=None, model=None):
        sent["redacted_text"] = redacted_text
        return dict(GOOD_ANSWERS)

    monkeypatch.setattr(main, "map_fields", fake_map_fields)
    monkeypatch.setenv("FORMFILL_DISABLE_SWEEP", "1")
    return sent


def map_claim():
    response = client.post("/map", json={"form_id": FORM, "patient": PATIENT})
    assert response.status_code == 200, response.text
    return response.json()


def final_values(rows, **edits):
    """What the review screen posts: every row, with the doctor's edits applied.

    Every row, because there is no server-side copy to fall back on — an
    omitted field is a blank one.
    """
    values = {row["field_id"]: row["value"] for row in rows}
    values.update(edits)
    return values


def test_health_and_forms():
    assert client.get("/health").json()["forms_loaded"] >= 1
    forms = client.get("/forms").json()
    # Real insurer forms are offered; the dev fixture is loaded (the tests
    # below use it by id) but hidden so a doctor never sees a fake form.
    assert forms, "no forms offered"
    assert all(f["form_id"] != FORM for f in forms)
    for form in forms:
        assert form["display_name"] and form["insurer"]
        assert all(f["label"] for f in form["fields"])


def test_review_rows_carry_human_labels():
    """The review screen renders row["label"], never the raw field_id."""
    fields = {f["field_id"]: f for f in map_claim()["fields"]}
    assert fields["patient_name"]["label"] == "Patient name"
    assert fields["diagnosis_primary"]["label"] == "Primary diagnosis"
    # LLM fields also carry the form's own question as help text.
    assert fields["diagnosis_primary"]["help"]
    assert all(row["label"] for row in fields.values())


def test_map_returns_review_rows(stub_llm):
    fields = {f["field_id"]: f for f in map_claim()["fields"]}
    assert fields["patient_name"]["value"] == "Tan Wei Ming"
    assert fields["patient_name"]["status"] == "demographic"
    assert fields["patient_dob"]["value"] == "14/03/1962"
    assert fields["diagnosis_primary"]["value"] == "Acute appendicitis"
    assert fields["symptoms_preexisting"]["needs_review"] is True
    # The LLM must only ever have seen redacted text.
    for identifier in ("Tan Wei Ming", "S1234567A", "91234567", "14/03/1962"):
        assert identifier not in stub_llm["redacted_text"]


def test_unknown_form_404():
    assert client.post("/map", json={"form_id": "nope", "patient": PATIENT}).status_code == 404
    assert client.post("/forms/nope/pdf", json={"values": {}}).status_code == 404


def test_mapping_error_becomes_502(monkeypatch):
    from mapping import MappingError

    def boom(*args, **kwargs):
        raise MappingError("mapping call hit max_tokens; output incomplete")

    monkeypatch.setattr(main, "map_fields", boom)
    response = client.post("/map", json={"form_id": FORM, "patient": PATIENT})
    assert response.status_code == 502


def test_fill_returns_the_pdf():
    rows = map_claim()["fields"]
    # Doctor edits one field on the review screen before filling.
    response = client.post(
        PDF_URL,
        json={"values": final_values(rows, diagnosis_primary="Acute appendicitis (K35.8)")},
    )
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/pdf"

    fields = PdfReader(io.BytesIO(response.content)).get_fields()
    assert fields["Text_PatientName"]["/V"] == "Tan Wei Ming"
    assert fields["Text_DOB"]["/V"] == "14/03/1962"
    assert fields["Text_Diagnosis1"]["/V"] == "Acute appendicitis (K35.8)"
    assert fields["Check_PreExisting"]["/V"] == "/Off"


def test_a_field_left_out_is_a_blank_field():
    # No server-side copy to fall back on. Stated as a test because it is the
    # one behavioural change from the old claim flow, where omitting a field
    # kept the mapped value.
    response = client.post(PDF_URL, json={"values": {"patient_name": "Tan Wei Ming"}})
    assert response.status_code == 200
    fields = PdfReader(io.BytesIO(response.content)).get_fields()
    assert fields["Text_PatientName"]["/V"] == "Tan Wei Ming"
    assert not fields["Text_Diagnosis1"].get("/V")


def test_fill_rejects_unknown_field_ids():
    response = client.post(PDF_URL, json={"values": {"not_a_field": "x"}})
    assert response.status_code == 422
    assert "not_a_field" in response.json()["detail"]


def test_fill_rejects_a_leftover_token():
    # A redaction token must never reach a PDF. Blocked at the fill layer as
    # well as the mapping one.
    rows = map_claim()["fields"]
    response = client.post(
        PDF_URL,
        json={"values": final_values(rows, diagnosis_primary="reviewed by [REDACTED_1]")},
    )
    assert response.status_code == 422
    assert "token" in response.json()["detail"]


def test_a_web_schema_has_no_pdf_to_return():
    response = client.post("/forms/roboform_test_v1/pdf", json={"values": {}})
    assert response.status_code == 422
    assert "browser" in response.json()["detail"]


class TestStatelessness:
    """The property that removed the retention window and the HA trap — and
    the one that would break silently if a cache were ever added."""

    def test_the_server_keeps_nothing_between_the_two_calls(self):
        # Filling works without the mapping call having happened at all, which
        # is only true if nothing is being looked up.
        response = client.post(PDF_URL, json={"values": {"patient_name": "Someone Else"}})
        assert response.status_code == 200

    def test_the_same_values_can_be_filled_twice(self):
        # The old flow deleted the claim on download, so a doctor who lost the
        # PDF had to start again. Nothing is consumed now.
        rows = map_claim()["fields"]
        payload = {"values": final_values(rows)}
        first = client.post(PDF_URL, json=payload)
        second = client.post(PDF_URL, json=payload)
        assert first.status_code == second.status_code == 200
        assert first.content == second.content

    def test_no_claim_routes_remain(self):
        # Asserted against the route table rather than by status code: the
        # catch-all static mount answers unmatched paths, so /claims returns
        # 405 rather than 404 and a status check would pass for the wrong
        # reason. (That same 405-not-404 is what a stale deployment looks
        # like from outside — it is how the old Fly build was spotted.)
        claim_routes = [
            r.path for r in main.app.routes if getattr(r, "path", "").startswith("/claims")
        ]
        assert claim_routes == []
        assert client.post("/claims", json={}).status_code != 200

    def test_the_app_holds_no_mutable_module_state(self):
        for name in ("_claims", "_claims_lock", "_purge_stale_claims"):
            assert not hasattr(main, name), f"{name} is back"
