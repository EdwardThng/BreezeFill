"""API tests: full create -> review -> approve -> download -> delete flow,
with the LLM stubbed out. Uses the committed dev_sample form + PDF."""

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
    main._claims.clear()
    yield sent
    main._claims.clear()


def create_claim():
    response = client.post("/claims", json={"form_id": "dev_sample_v1", "patient": PATIENT})
    assert response.status_code == 200, response.text
    return response.json()


def test_health_and_forms():
    assert client.get("/health").json()["forms_loaded"] >= 1
    forms = client.get("/forms").json()
    assert any(f["form_id"] == "dev_sample_v1" for f in forms)


def test_create_claim_returns_review_rows(stub_llm):
    body = create_claim()
    fields = {f["field_id"]: f for f in body["fields"]}
    assert fields["patient_name"]["value"] == "Tan Wei Ming"
    assert fields["patient_name"]["status"] == "demographic"
    assert fields["patient_dob"]["value"] == "14/03/1962"
    assert fields["diagnosis_primary"]["value"] == "Acute appendicitis"
    assert fields["symptoms_preexisting"]["needs_review"] is True
    # The LLM must only ever have seen redacted text.
    for identifier in ("Tan Wei Ming", "S1234567A", "91234567", "14/03/1962"):
        assert identifier not in stub_llm["redacted_text"]


def test_unknown_form_404():
    response = client.post("/claims", json={"form_id": "nope", "patient": PATIENT})
    assert response.status_code == 404


def test_mapping_error_becomes_502(monkeypatch):
    from mapping import MappingError

    def boom(*args, **kwargs):
        raise MappingError("mapping call hit max_tokens; output incomplete")

    monkeypatch.setattr(main, "map_fields", boom)
    response = client.post("/claims", json={"form_id": "dev_sample_v1", "patient": PATIENT})
    assert response.status_code == 502


def test_approve_returns_pdf_and_deletes_claim():
    body = create_claim()
    claim_id = body["claim_id"]

    # Doctor edits one field and accepts the inferred checkbox.
    response = client.post(
        f"/claims/{claim_id}/approve",
        json={"values": {"diagnosis_primary": "Acute appendicitis (K35.8)"}},
    )
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/pdf"

    fields = PdfReader(io.BytesIO(response.content)).get_fields()
    assert fields["Text_PatientName"]["/V"] == "Tan Wei Ming"
    assert fields["Text_DOB"]["/V"] == "14/03/1962"
    assert fields["Text_Diagnosis1"]["/V"] == "Acute appendicitis (K35.8)"
    assert fields["Check_PreExisting"]["/V"] == "/Off"

    # Zero retention: the claim is gone after download.
    assert client.get(f"/claims/{claim_id}").status_code == 404


def test_approve_rejects_unknown_field_ids():
    claim_id = create_claim()["claim_id"]
    response = client.post(
        f"/claims/{claim_id}/approve", json={"values": {"not_a_field": "x"}}
    )
    assert response.status_code == 422
    # Claim survives a failed approve so the doctor can retry.
    assert client.get(f"/claims/{claim_id}").status_code == 200


def test_approve_rejects_leftover_token(monkeypatch):
    answers = dict(GOOD_ANSWERS)
    monkeypatch.setattr(
        main,
        "map_fields",
        lambda *a, **k: answers,
    )
    claim_id = create_claim()["claim_id"]
    response = client.post(
        f"/claims/{claim_id}/approve",
        json={"values": {"diagnosis_primary": "reviewed by [REDACTED_1]"}},
    )
    assert response.status_code == 422
    assert "token" in response.json()["detail"]


def test_get_and_discard_claim():
    claim_id = create_claim()["claim_id"]
    assert client.get(f"/claims/{claim_id}").status_code == 200
    assert client.delete(f"/claims/{claim_id}").status_code == 204
    assert client.get(f"/claims/{claim_id}").status_code == 404
