"""POST /forms/upload, and what the rest of the API does with what it returns.

The property worth proving here is the one that is easy to lose: an uploaded
form must reach the ordinary mapping and fill routes as an ordinary form, with
nothing remembered between the request that uploaded it and the request that
fills it.
"""

import base64
import json
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).parent))

import main  # noqa: E402
from form_bank import LocalBank  # noqa: E402
from pdf_fill import fill_pdf  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parent.parent
DEV_PDF = REPO_ROOT / "forms" / "dev_sample.pdf"
SCANNED = REPO_ROOT / "forms" / "scans_unsupported" / "henner_prior_agreement.pdf"


class StubVision:
    """The vision call, replaced. Two believable boxes on every page."""

    def __init__(self) -> None:
        self.calls = 0
        self.messages = self

    def create(self, **kwargs):
        self.calls += 1
        fields = [
            {"label": "Diagnosis", "description": "", "type": "text",
             "options": [], "x": 0.1, "y": 0.30, "w": 0.5, "h": 0.02},
            {"label": "NRIC / FIN", "description": "", "type": "text",
             "options": [], "x": 0.1, "y": 0.40, "w": 0.5, "h": 0.02},
        ]

        class Block:
            type = "text"

            def __init__(self, text):
                self.text = text

        class Response:
            stop_reason = "end_turn"

            def __init__(self, text):
                self.content = [Block(text)]

        return Response(json.dumps({"fields": fields}))

client = TestClient(main.app)


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


class StubClient:
    """Anthropic, replaced. Names every box after the PDF field behind it."""

    def __init__(self) -> None:
        self.calls = 0
        self.messages = self

    def create(self, **kwargs):
        self.calls += 1
        import re

        prompt = kwargs["messages"][0]["content"]
        boxes = []
        for ref, name in re.findall(r'ref="(b\d+)" pdf_name="([^"]*)"', prompt):
            label = {
                "Text_PatientName": "Patient Name",
                "Text_DOB": "Date of Birth",
                "Text_Diagnosis1": "Diagnosis",
                "Date_FirstConsult": "Date of first consultation",
                "Check_PreExisting": "Pre-existing condition",
            }.get(name, name)
            boxes.append({
                "ref": ref,
                "label": label,
                "description": "",
                "type": "text",
                "options": [],
                "include": True,
            })

        class Block:
            type = "text"

            def __init__(self, text):
                self.text = text

        class Response:
            stop_reason = "end_turn"

            def __init__(self, text):
                self.content = [Block(text)]

        return Response(json.dumps({"boxes": boxes}))


@pytest.fixture
def bank(tmp_path, monkeypatch):
    """A bank on disk, per test. Also proves the route never touches the real
    one — a test that banked into production storage would be a leak of a
    different kind."""
    store = LocalBank(tmp_path)
    monkeypatch.setattr(main, "_BANK", store)
    return store


@pytest.fixture
def no_model(monkeypatch):
    """Derivation answered locally. Every test here is about the plumbing
    around the model call, not the call."""
    stub = StubClient()
    real = main.derive_schema

    def derive(data, form_id, **kwargs):
        return real(data, form_id, client=stub, **kwargs)

    monkeypatch.setattr(main, "derive_schema", derive)

    # The scanned path too, so a test that reaches it does not call Anthropic.
    vision = StubVision()
    real_overlay = main.derive_overlay_schema

    def derive_overlay(data, form_id, **kwargs):
        return real_overlay(data, form_id, client=vision, **kwargs)

    monkeypatch.setattr(main, "derive_overlay_schema", derive_overlay)
    stub.vision = vision
    return stub


class TestUploadingABlankForm:
    def test_a_fillable_form_comes_back_as_a_list_of_questions(self, bank, no_model) -> None:
        response = client.post(
            "/forms/upload",
            json={"pdf_base64": b64(DEV_PDF.read_bytes()), "filename": "dev_sample.pdf"},
        )
        assert response.status_code == 200
        body = response.json()
        assert body["form_id"].startswith("upload_")
        assert body["display_name"] == "dev sample"
        assert body["known"] is False
        assert {f["label"] for f in body["fields"]} >= {"Diagnosis", "Patient Name"}

    def test_the_demographics_are_marked_as_such(self, bank, no_model) -> None:
        # Shown to the doctor because these are the boxes answered from what
        # they typed rather than from the note — and they arrive already green.
        response = client.post(
            "/forms/upload", json={"pdf_base64": b64(DEV_PDF.read_bytes())}
        )
        by_label = {f["label"]: f for f in response.json()["fields"]}
        assert by_label["Patient Name"]["source"] == "demographics.full_name"
        assert by_label["Diagnosis"]["source"] == "llm"

    def test_sending_the_same_form_twice_derives_it_once(self, bank, no_model) -> None:
        payload = {"pdf_base64": b64(DEV_PDF.read_bytes()), "filename": "dev_sample.pdf"}
        first = client.post("/forms/upload", json=payload)
        after_first = no_model.calls
        second = client.post("/forms/upload", json=payload)

        assert no_model.calls == after_first, "the second upload paid for a model call"
        assert second.json()["known"] is True
        assert first.json()["form_id"] == second.json()["form_id"]

    def test_the_same_form_under_a_different_filename_is_still_the_same_form(
        self, bank, no_model
    ) -> None:
        # The key is the PDF's bytes. A doctor who renamed the file, or saved
        # it from a different mailbox, must not pay to derive it again.
        data = b64(DEV_PDF.read_bytes())
        one = client.post("/forms/upload", json={"pdf_base64": data, "filename": "a.pdf"})
        two = client.post("/forms/upload", json={"pdf_base64": data, "filename": "b.pdf"})
        assert one.json()["form_id"] == two.json()["form_id"]


class TestWhatIsRefused:
    def test_a_scan_is_refused_when_this_deployment_cannot_render(
        self, bank, no_model, monkeypatch
    ) -> None:
        # PyMuPDF was a calibration-only dependency for most of this project's
        # life. A deployment without it must refuse a scan the way it always
        # did, rather than raise ImportError on the first doctor who sends one.
        monkeypatch.setattr(main, "vision_available", lambda: False)
        response = client.post(
            "/forms/upload", json={"pdf_base64": b64(SCANNED.read_bytes())}
        )
        assert response.status_code == 422
        assert "scan" in response.json()["detail"]
        assert no_model.calls == 0, "a scan should cost nothing when it cannot be read"

    def test_a_filled_claim_is_refused_and_never_banked(self, bank, no_model) -> None:
        filled = fill_pdf(DEV_PDF, {"Text_PatientName": "A Synthetic Patient"})
        response = client.post("/forms/upload", json={"pdf_base64": b64(filled)})

        assert response.status_code == 422
        assert "blank form" in response.json()["detail"]
        # The check that matters: nothing about that claim reached storage.
        assert list(Path(bank.root).glob("*")) == []

    def test_something_that_is_not_a_pdf_is_refused(self, bank, no_model) -> None:
        response = client.post("/forms/upload", json={"pdf_base64": b64(b"not a pdf")})
        assert response.status_code == 422

    def test_an_empty_upload_is_refused(self, bank, no_model) -> None:
        response = client.post("/forms/upload", json={"pdf_base64": ""})
        assert response.status_code == 422

    def test_junk_that_is_not_base64_is_refused_rather_than_raising(self, bank, no_model) -> None:
        response = client.post("/forms/upload", json={"pdf_base64": "!!!! not base64 !!!!"})
        assert response.status_code == 422

    def test_an_oversized_upload_is_refused_before_it_is_parsed(self, bank, no_model) -> None:
        huge = b64(b"%PDF-1.4" + b"\\0" * (main.MAX_UPLOAD_BYTES + 1))
        response = client.post("/forms/upload", json={"pdf_base64": huge})
        assert response.status_code == 413


class TestAnUploadedFormIsAnOrdinaryForm:
    """The requests after the upload must find it without anything having been
    remembered between them."""

    def test_the_form_is_found_again_by_its_id_alone(self, bank, no_model) -> None:
        form_id = client.post(
            "/forms/upload", json={"pdf_base64": b64(DEV_PDF.read_bytes())}
        ).json()["form_id"]

        # A different machine would have this and nothing else. Everything
        # cached in the process is thrown away to prove the id is sufficient.
        main.FORM_SCHEMAS.pop(form_id, None)
        schema = main._get_schema(form_id)
        assert schema.form_id == form_id
        assert schema.fill_mode == "acroform"

    def test_the_filled_pdf_comes_back_from_the_banked_blank(self, bank, no_model) -> None:
        uploaded = client.post(
            "/forms/upload", json={"pdf_base64": b64(DEV_PDF.read_bytes())}
        ).json()
        diagnosis = next(f for f in uploaded["fields"] if f["label"] == "Diagnosis")

        response = client.post(
            f"/forms/{uploaded['form_id']}/pdf",
            json={"values": {diagnosis["id"]: "Acute tonsillitis"}},
        )
        assert response.status_code == 200
        assert response.headers["content-type"] == "application/pdf"
        assert response.content.startswith(b"%PDF-")

    def test_a_fill_for_a_form_no_longer_in_the_bank_says_so(self, bank, no_model) -> None:
        uploaded = client.post(
            "/forms/upload", json={"pdf_base64": b64(DEV_PDF.read_bytes())}
        ).json()
        schema = main._get_schema(uploaded["form_id"])
        for path in Path(bank.root).glob("*.pdf"):
            path.unlink()
        main.FORM_SCHEMAS[schema.form_id] = schema  # schema survives, blank does not

        response = client.post(
            f"/forms/{uploaded['form_id']}/pdf", json={"values": {}}
        )
        main.FORM_SCHEMAS.pop(schema.form_id, None)
        assert response.status_code == 410
        assert "Upload it again" in response.json()["detail"]

    def test_an_unknown_upload_id_is_a_404_not_a_crash(self, bank) -> None:
        response = client.post(f"/forms/upload_{'a' * 32}/pdf", json={"values": {}})
        assert response.status_code == 404

    def test_uploaded_forms_stay_out_of_the_public_picker(self, bank, no_model) -> None:
        # `/forms` is the curated bank a doctor is offered. One clinic's upload
        # is not something to put in front of another's.
        client.post("/forms/upload", json={"pdf_base64": b64(DEV_PDF.read_bytes())})
        listed = [f["form_id"] for f in client.get("/forms").json()]
        assert not any(f.startswith("upload_") for f in listed)


class TestAScannedFormTakesTheVisionPath:
    """Five of the seven real insurer forms have no fields and no text. This is
    the only way to read them, and the only one whose geometry rests on nothing
    but the model's word."""

    def test_a_scan_becomes_an_overlay_schema(self, bank, no_model) -> None:
        response = client.post(
            "/forms/upload",
            json={"pdf_base64": b64(SCANNED.read_bytes()), "filename": "henner.pdf"},
        )
        assert response.status_code == 200
        body = response.json()
        assert body["fill_mode"] == "overlay"
        assert {f["label"] for f in body["fields"]} == {"Diagnosis", "NRIC / FIN"}

    def test_the_doctor_is_told_which_kind_of_reading_this_was(self, bank, no_model) -> None:
        # Only one of the two needs its geometry checked, so the difference has
        # to reach the surface that decides whether to show a proof sheet.
        scan = client.post("/forms/upload", json={"pdf_base64": b64(SCANNED.read_bytes())})
        fillable = client.post("/forms/upload", json={"pdf_base64": b64(DEV_PDF.read_bytes())})
        assert scan.json()["fill_mode"] == "overlay"
        assert fillable.json()["fill_mode"] == "acroform"

    def test_a_fillable_form_never_reaches_the_vision_path(self, bank, no_model) -> None:
        # It costs a model call per page and its geometry is guessed. A PDF
        # that states where its own boxes are must never be read by looking.
        client.post("/forms/upload", json={"pdf_base64": b64(DEV_PDF.read_bytes())})
        assert no_model.vision.calls == 0

    def test_a_scanned_form_is_banked_like_any_other(self, bank, no_model) -> None:
        payload = {"pdf_base64": b64(SCANNED.read_bytes())}
        client.post("/forms/upload", json=payload)
        before = no_model.vision.calls
        second = client.post("/forms/upload", json=payload)

        assert no_model.vision.calls == before, "the second upload paid for vision again"
        assert second.json()["known"] is True

    def test_the_filled_scan_comes_back_as_a_pdf(self, bank, no_model) -> None:
        uploaded = client.post(
            "/forms/upload", json={"pdf_base64": b64(SCANNED.read_bytes())}
        ).json()
        diagnosis = next(f for f in uploaded["fields"] if f["label"] == "Diagnosis")

        response = client.post(
            f"/forms/{uploaded['form_id']}/pdf",
            json={"values": {diagnosis["id"]: "Acute tonsillitis"}},
        )
        assert response.status_code == 200
        assert response.content.startswith(b"%PDF-")


class TestTheProofSheet:
    """The answer to the one thing review cannot show a doctor: a box that is
    in the wrong place. They cannot audit a schema; they can look at their own
    form with the boxes drawn on it."""

    def test_the_proof_sheet_is_the_form_with_the_boxes_stamped_on_it(
        self, bank, no_model
    ) -> None:
        uploaded = client.post(
            "/forms/upload", json={"pdf_base64": b64(SCANNED.read_bytes())}
        ).json()

        response = client.post(f"/forms/{uploaded['form_id']}/proof")
        assert response.status_code == 200
        assert response.headers["content-type"] == "application/pdf"
        assert response.content.startswith(b"%PDF-")

    def test_it_is_shown_in_the_browser_rather_than_downloaded(self, bank, no_model) -> None:
        # A doctor checks it and goes back. Putting it in Downloads beside the
        # filled forms is a way to sign the wrong file later.
        uploaded = client.post(
            "/forms/upload", json={"pdf_base64": b64(SCANNED.read_bytes())}
        ).json()
        response = client.post(f"/forms/{uploaded['form_id']}/proof")
        assert response.headers["content-disposition"].startswith("inline")

    def test_every_field_id_is_stamped_somewhere(self, bank, no_model) -> None:
        uploaded = client.post(
            "/forms/upload", json={"pdf_base64": b64(SCANNED.read_bytes())}
        ).json()
        proof = client.post(f"/forms/{uploaded['form_id']}/proof").content

        import io

        from pypdf import PdfReader

        text = "".join(page.extract_text() or "" for page in PdfReader(io.BytesIO(proof)).pages)
        for f in uploaded["fields"]:
            assert f["id"] in text, f"{f['id']} was not drawn on the proof sheet"

    def test_a_fillable_form_has_no_geometry_to_check(self, bank, no_model) -> None:
        uploaded = client.post(
            "/forms/upload", json={"pdf_base64": b64(DEV_PDF.read_bytes())}
        ).json()
        response = client.post(f"/forms/{uploaded['form_id']}/proof")
        assert response.status_code == 422
        assert "own fillable boxes" in response.json()["detail"]

    def test_an_unknown_form_is_a_404(self, bank) -> None:
        assert client.post(f"/forms/upload_{'b' * 32}/proof").status_code == 404
