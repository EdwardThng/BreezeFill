"""Reading a consultation note out of an uploaded PDF.

Every note in here is synthetic, as repo fixtures must be. The names and
identifiers are invented and belong to nobody.
"""

import base64
import io
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pypdf import PdfWriter
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

sys.path.insert(0, str(Path(__file__).parent))

import main  # noqa: E402
from note_intake import (  # noqa: E402
    MIN_NOTE_CHARS,
    NoteIntakeError,
    SCANNED_NOTE_REFUSAL,
    extract_note_text,
)

client = TestClient(main.app)

NOTE_LINES = [
    "CONSULTATION NOTE",
    "Patient: Synthetic Test Patient",
    "NRIC S8012345D   DOB 14/03/1978",
    "Seen 03/07/2026 for sore throat and fever of three days.",
    "O/E: temp 38.4, tonsils inflamed with exudate.",
    "Dx: acute tonsillitis. Rx amoxicillin 500mg TDS 7/7.",
    "MC 2 days.",
]


def note_pdf(lines: list[str] | None = None, pages: int = 1) -> bytes:
    """A synthetic note as a text-layer PDF, the way a clinic system exports."""
    buffer = io.BytesIO()
    pdf = canvas.Canvas(buffer, pagesize=A4)
    for page in range(pages):
        y = 800
        for line in lines if lines is not None else NOTE_LINES:
            pdf.drawString(60, y, f"{line}" if pages == 1 else f"[p{page + 1}] {line}")
            y -= 18
        pdf.showPage()
    pdf.save()
    return buffer.getvalue()


def blank_pdf(pages: int = 1) -> bytes:
    """A page with no text layer at all — what a scan looks like to pypdf."""
    writer = PdfWriter()
    for _ in range(pages):
        writer.add_blank_page(width=595, height=842)
    buffer = io.BytesIO()
    writer.write(buffer)
    return buffer.getvalue()


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


class TestExtractingTheText:
    def test_a_clinic_exported_note_comes_back_as_text(self) -> None:
        text = extract_note_text(note_pdf())
        assert "acute tonsillitis" in text
        assert "S8012345D" in text

    def test_every_page_is_read_in_order(self) -> None:
        text = extract_note_text(note_pdf(pages=3))
        assert text.index("[p1]") < text.index("[p2]") < text.index("[p3]")

    def test_a_scan_is_refused_and_says_what_to_do_instead(self) -> None:
        with pytest.raises(NoteIntakeError) as caught:
            extract_note_text(blank_pdf())
        assert str(caught.value) == SCANNED_NOTE_REFUSAL
        assert "copy and paste" in str(caught.value)

    def test_a_near_empty_text_layer_counts_as_a_scan(self) -> None:
        # A stray watermark or form-feed is not a note. Without the floor, a
        # scan carrying six characters would be mapped as though it were one.
        with pytest.raises(NoteIntakeError):
            extract_note_text(note_pdf(["Page 1 of 2"]))

    def test_the_floor_is_low_enough_for_a_short_real_note(self) -> None:
        # The positive case beside the refusal. A one-line note is a real
        # thing a GP writes, and `docs/test_notes.md` case 5 is exactly that.
        short = "Seen 03/07/2026. URTI, symptomatic treatment, MC 1 day given."
        assert len(short) > MIN_NOTE_CHARS
        assert "URTI" in extract_note_text(note_pdf([short]))

    def test_something_that_is_not_a_pdf_is_refused(self) -> None:
        with pytest.raises(NoteIntakeError):
            extract_note_text(b"not a pdf at all")

    def test_no_refusal_ever_quotes_the_note(self) -> None:
        # This module is holding a patient's clinical note when it raises, and
        # the message reaches an HTTP response and possibly a log.
        for bad in (b"not a pdf at all", blank_pdf()):
            with pytest.raises(NoteIntakeError) as caught:
                extract_note_text(bad)
            message = str(caught.value)
            assert not any(line.split()[0] in message for line in NOTE_LINES if line)


class TestTheRoute:
    def test_a_note_pdf_is_turned_into_text_for_the_doctor_to_check(self) -> None:
        response = client.post("/notes/extract", json={"pdf_base64": b64(note_pdf())})
        assert response.status_code == 200
        assert "acute tonsillitis" in response.json()["text"]

    def test_a_scanned_note_is_refused_with_the_reason(self) -> None:
        response = client.post("/notes/extract", json={"pdf_base64": b64(blank_pdf())})
        assert response.status_code == 422
        assert "scan" in response.json()["detail"]

    def test_junk_that_is_not_base64_is_refused_rather_than_raising(self) -> None:
        response = client.post("/notes/extract", json={"pdf_base64": "!!! nope !!!"})
        assert response.status_code == 422

    def test_an_empty_upload_is_refused(self) -> None:
        response = client.post("/notes/extract", json={"pdf_base64": ""})
        assert response.status_code == 422

    def test_an_oversized_upload_is_refused(self) -> None:
        huge = b64(b"%PDF-1.4" + b"0" * (main.MAX_UPLOAD_BYTES + 1))
        response = client.post("/notes/extract", json={"pdf_base64": huge})
        assert response.status_code == 413

    def test_the_route_never_reaches_a_model(self, monkeypatch) -> None:
        # It extracts and stops. Anything else here would be a call on the
        # unredacted note, one step before redaction has a dictionary.
        def explode(*args, **kwargs):
            raise AssertionError("a model was called while holding a raw note")

        monkeypatch.setattr(main, "map_fields", explode)
        monkeypatch.setattr(main, "llm_sweep", explode)
        assert client.post(
            "/notes/extract", json={"pdf_base64": b64(note_pdf())}
        ).status_code == 200
