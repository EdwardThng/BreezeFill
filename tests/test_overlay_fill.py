"""Overlay fill: geometry, guardrails, and the no-spill invariant."""

from __future__ import annotations

import io
import sys
from pathlib import Path

import pytest
from pypdf import PdfReader, PdfWriter

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from overlay_fill import (  # noqa: E402
    FONT,
    MIN_FONT_SIZE,
    PADDING,
    FieldBox,
    OverlayFillError,
    _fit_lines,
    _hard_wrap,
    overlay_fill,
)
from reportlab.pdfbase.pdfmetrics import stringWidth  # noqa: E402

A4 = (595.0, 842.0)


@pytest.fixture
def flat_pdf(tmp_path: Path) -> Path:
    """A blank two-page A4 PDF standing in for a scan: no AcroForm fields."""
    writer = PdfWriter()
    for _ in range(2):
        writer.add_blank_page(*A4)
    path = tmp_path / "flat.pdf"
    writer.write(str(path))
    return path


def extract(pdf_bytes: bytes, page: int = 0) -> str:
    return PdfReader(io.BytesIO(pdf_bytes)).pages[page].extract_text() or ""


def test_values_land_on_their_page(flat_pdf: Path):
    boxes = {
        "a": FieldBox(page=1, x=50, y=100, w=200, h=20),
        "b": FieldBox(page=2, x=50, y=100, w=200, h=20),
    }
    out = overlay_fill(flat_pdf, boxes, {"a": "alpha", "b": "bravo"})
    assert "alpha" in extract(out, 0)
    assert "bravo" in extract(out, 1)
    assert "bravo" not in extract(out, 0)


def test_blank_values_draw_nothing(flat_pdf: Path):
    """None/""/False are blanks the doctor completes by hand, not errors."""
    boxes = {k: FieldBox(page=1, x=50, y=100 + i * 30, w=200, h=20)
             for i, k in enumerate(["a", "b", "c", "d"])}
    out = overlay_fill(flat_pdf, boxes, {"a": None, "b": "", "c": False, "d": "kept"})
    text = extract(out)
    assert "kept" in text
    assert text.strip() == "kept"


def test_checkbox_true_draws_a_mark(flat_pdf: Path):
    boxes = {"tick": FieldBox(page=1, x=50, y=100, w=12, h=12)}
    assert "X" in extract(overlay_fill(flat_pdf, boxes, {"tick": True}))


def test_redaction_token_is_rejected(flat_pdf: Path):
    """Defense in depth: a raw token must never reach a filled PDF."""
    boxes = {"a": FieldBox(page=1, x=50, y=100, w=200, h=20)}
    with pytest.raises(OverlayFillError) as exc:
        overlay_fill(flat_pdf, boxes, {"a": "seen by [PATIENT] today"})
    assert "a" in str(exc.value)
    # The message must not leak the value itself.
    assert "[PATIENT]" not in str(exc.value)


def test_value_without_a_box_is_rejected(flat_pdf: Path):
    with pytest.raises(OverlayFillError):
        overlay_fill(flat_pdf, {}, {"nope": "x"})


def test_box_beyond_last_page_is_rejected(flat_pdf: Path):
    boxes = {"a": FieldBox(page=9, x=50, y=100, w=200, h=20)}
    with pytest.raises(OverlayFillError) as exc:
        overlay_fill(flat_pdf, boxes, {"a": "x"})
    assert "page 9" in str(exc.value)


def test_unbreakable_token_never_exceeds_box_width():
    """The bug the AIA proof render caught: a single long token used to run
    straight over the neighbouring column, putting text under the wrong
    heading."""
    box = FieldBox(page=1, x=0, y=0, w=50, h=60)
    lines, size = _fit_lines("A" * 80, box)
    usable = box.w - 2 * PADDING
    assert lines
    for line in lines:
        assert stringWidth(line, FONT, size) <= usable + 0.01


def test_long_prose_shrinks_rather_than_overflowing_height():
    tight = FieldBox(page=1, x=0, y=0, w=200, h=30)
    lines, size = _fit_lines("word " * 60, tight)
    assert size < 11.0
    assert len(lines) * size * 1.15 <= tight.h - 2 * PADDING + 0.01


def test_hopeless_value_is_clipped_not_spilled():
    """A value that cannot fit even at the floor size is cut to the box."""
    tiny = FieldBox(page=1, x=0, y=0, w=60, h=14)
    lines, size = _fit_lines("word " * 200, tiny)
    assert size == MIN_FONT_SIZE
    assert len(lines) * size * 1.15 <= tiny.h - 2 * PADDING + 0.01


def test_hard_wrap_preserves_content_when_it_fits():
    lines = _hard_wrap("short enough", 10, 200)
    assert "".join(lines).replace(" ", "") == "shortenough"
