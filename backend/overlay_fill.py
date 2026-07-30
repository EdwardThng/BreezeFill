"""Coordinate-overlay fill for flat (scanned) insurer forms.

Some insurers publish no fillable version of their form, and the clinic only
has a phone scan — a photograph of a form, with no AcroForm fields to write
into. For those, the schema carries an explicit box per field and this module
stamps the approved values onto the page at those coordinates.

Design notes:

- **Boxes are measured from the TOP-LEFT of the page, in points.** PDF's own
  origin is bottom-left, which is miserable to calibrate against a rendered
  image; the conversion happens here, once, in `_box_to_pdf_rect`.
- Text is wrapped to the box width and the font shrinks (to a floor) until it
  fits the box height. A value that still doesn't fit is clipped rather than
  allowed to spill across neighbouring boxes — a legible short answer beats
  an illegible overlap, and the doctor reviews the PDF before signing.
- Same guardrail as the AcroForm path: a value still containing a redaction
  [TOKEN] is rejected here, so a raw token can never reach a filled PDF.
"""

from __future__ import annotations

import io
from pathlib import Path

from pydantic import BaseModel, Field
from pypdf import PdfReader, PdfWriter
from reportlab.lib.utils import simpleSplit
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen import canvas

from redaction import TOKEN_RE

FONT = "Helvetica"
# Below this the handwriting-sized print stops being legible on a printed scan.
MIN_FONT_SIZE = 6.0
MAX_FONT_SIZE = 11.0
PADDING = 2.0


class OverlayFillError(Exception):
    """Bad box geometry or unsafe value. Never include clinical text or
    patient data in the message — field ids only."""


class FieldBox(BaseModel):
    """Where a field's value goes, in points from the page's top-left corner.

    `page` is 1-indexed to match what a person sees in a PDF viewer while
    calibrating.
    """

    page: int = Field(ge=1)
    x: float = Field(ge=0)
    y: float = Field(ge=0)
    w: float = Field(gt=0)
    h: float = Field(gt=0)
    # Optional per-field override when a box is unusually tight or roomy.
    size: float | None = Field(default=None, gt=0)


def _box_to_pdf_rect(box: FieldBox, page_height: float) -> tuple[float, float]:
    """Top-left origin (calibration) -> bottom-left origin (PDF). Returns the
    baseline start of the FIRST line: left edge plus padding, and the top of
    the box measured up from the page bottom."""
    left = box.x + PADDING
    top = page_height - box.y - PADDING
    return left, top


def _hard_wrap(text: str, size: float, usable_w: float) -> list[str]:
    """Wrap to `usable_w`, breaking mid-word when a single token is wider than
    the box.

    simpleSplit only breaks on spaces, so an unbreakable token — a long
    surgical code, a hyphen-free hospital name — silently overflowed into the
    neighbouring field. On a form where adjacent boxes are different questions
    that puts text under the wrong heading, so it is cut instead.
    """
    lines: list[str] = []
    for line in simpleSplit(text, FONT, size, usable_w):
        while len(line) > 1 and stringWidth(line, FONT, size) > usable_w:
            cut = len(line)
            while cut > 1 and stringWidth(line[:cut], FONT, size) > usable_w:
                cut -= 1
            lines.append(line[:cut])
            line = line[cut:]
        lines.append(line)
    return lines


def _fit_lines(text: str, box: FieldBox) -> tuple[list[str], float]:
    """Largest font size at which `text` fits the box, and the lines at that
    size. Falls back to MIN_FONT_SIZE with the lines clipped to the box."""
    usable_w = box.w - 2 * PADDING
    usable_h = box.h - 2 * PADDING
    ceiling = box.size or MAX_FONT_SIZE

    size = ceiling
    while size >= MIN_FONT_SIZE:
        lines = _hard_wrap(text, size, usable_w)
        if len(lines) * size * 1.15 <= usable_h:
            return lines, size
        size -= 0.5

    # Nothing fits: keep as many lines as the box holds rather than spilling.
    lines = _hard_wrap(text, MIN_FONT_SIZE, usable_w)
    max_lines = max(1, int(usable_h // (MIN_FONT_SIZE * 1.15)))
    return lines[:max_lines], MIN_FONT_SIZE


def _draw_text(c: canvas.Canvas, box: FieldBox, page_height: float, text: str) -> None:
    lines, size = _fit_lines(text, box)
    left, top = _box_to_pdf_rect(box, page_height)
    c.setFont(FONT, size)
    for i, line in enumerate(lines):
        # First baseline sits one line-height below the box top.
        c.drawString(left, top - size * (1.0 + 1.15 * i), line)


def _draw_check(c: canvas.Canvas, box: FieldBox, page_height: float) -> None:
    """A tick box on a scan has no export value to set — draw an X that fills
    the box, sized so it reads clearly at print resolution."""
    size = min(box.w, box.h) * 0.9
    left, top = _box_to_pdf_rect(box, page_height)
    c.setFont(FONT, size)
    c.drawString(left, top - size, "X")


def overlay_fill(
    pdf_path: str | Path,
    boxes: dict[str, FieldBox],
    values: dict[str, str | bool | None],
) -> bytes:
    """Stamp `values` onto a flat PDF at the coordinates in `boxes`.

    Keys of both dicts are field ids. A value of None, "", or False draws
    nothing — a blank the doctor completes by hand.
    """
    reader = PdfReader(str(pdf_path))
    page_count = len(reader.pages)

    unknown = sorted(set(values) - set(boxes))
    if unknown:
        raise OverlayFillError(f"no box defined for field ids: {unknown}")

    # Group by page so each page is stamped in a single overlay pass.
    per_page: dict[int, list[tuple[FieldBox, str | bool]]] = {}
    for field_id, raw in values.items():
        if raw is None or raw == "" or raw is False:
            continue
        if isinstance(raw, str) and TOKEN_RE.search(raw):
            raise OverlayFillError(f"unresolved redaction token in field {field_id!r}")
        box = boxes[field_id]
        if box.page > page_count:
            raise OverlayFillError(
                f"field {field_id!r} targets page {box.page}, PDF has {page_count}"
            )
        per_page.setdefault(box.page, []).append((box, raw))

    writer = PdfWriter()
    for index, page in enumerate(reader.pages, start=1):
        entries = per_page.get(index)
        if entries:
            width = float(page.mediabox.width)
            height = float(page.mediabox.height)
            buffer = io.BytesIO()
            c = canvas.Canvas(buffer, pagesize=(width, height))
            for box, raw in entries:
                if raw is True:
                    _draw_check(c, box, height)
                else:
                    _draw_text(c, box, height, str(raw))
            c.save()
            buffer.seek(0)
            page.merge_page(PdfReader(buffer).pages[0])
        writer.add_page(page)

    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()


def text_width(text: str, size: float) -> float:
    """Exposed for the calibration tooling in scripts/."""
    return stringWidth(text, FONT, size)
