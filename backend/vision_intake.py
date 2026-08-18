"""Reading a SCANNED blank insurer form — one with no fields and no text.

Five of the seven real insurer forms in `forms/` are images of paper. No
AcroForm boxes to enumerate, no text layer to read: `extract_text()` returns
the empty string and `get_fields()` returns nothing. They are also, not
coincidentally, the forms doctors print and fill by hand, because that is why
they get printed. `form_intake.py` refuses them; this reads them.

HOW, AND WHY THE PIECES ALREADY FIT
-----------------------------------

Render each page, ask the model to locate every box on it, convert what comes
back into a `FieldBox`, and hand the result to `overlay_fill` — which has
existed since the three overlay schemas were hand-calibrated and takes exactly
what a vision model produces. Its own docstring says why its coordinates are
measured from the page's TOP-LEFT:

    PDF's own origin is bottom-left, which is miserable to calibrate against
    a rendered image

Top-left is how an image is addressed, so the conversion here is a multiply
with no flip. Everything downstream — the mapper, the review screen, the
redaction guards, the unresolved-token check, the font-shrink-to-fit, the
clip-rather-than-spill rule — is the machinery the hand-calibrated forms
already run on.

WHAT MAY BE SENT, AND WHY AN IMAGE IS ALLOWED AT ALL
---------------------------------------------------

The page image is a BLANK insurer form: a published document with no patient
in it. That is the same exception `form_intake` documents, and it rests on the
same check — `probe_pdf().already_filled`, which refuses a PDF whose fields
carry values. A scan has no fields to inspect, so for this path that check
proves less than it does for a fillable one, and the honest statement of the
residual risk is in `derive_overlay_schema`.

Nothing about a patient is in scope here. The consultation note is not part of
this call and never reaches it.

THE RISK THIS MODULE HAS AND THE ACROFORM PATH DOES NOT
-------------------------------------------------------

A fillable PDF states where its boxes are. Here the model says, and a model is
good at reading a form and only approximately good at localising to a few
points. **A box 15pt too high stamps the answer onto the ruled line above it**,
and on a 96-box form that happens somewhere.

So this module refuses more than it accepts, and the refusals are in
`_to_box`. What it cannot do is notice a box that is merely slightly wrong,
which is the common case — that is what the proof sheet is for
(`POST /forms/{id}/proof`), and it is the reason this path shows the doctor
the form with every box drawn on it before a single value is filled.
"""

from __future__ import annotations

import base64
import json
import os
from typing import Any

from mapping import FormField, FormSchema
from overlay_fill import FieldBox

VISION_MODEL = os.environ.get("FORMFILL_VISION_MODEL", "claude-opus-5")

# Anthropic resizes an image so its long edge is at most 1568px, so rendering
# larger is tokens spent on pixels that get thrown away.
TARGET_LONG_EDGE_PX = 1500

# JPEG rather than PNG: these pages ARE photographs of paper, already carrying
# the artefacts of whatever scanned them, and the lossless copy is 6.5x larger
# for no legibility a model can use.
JPEG_QUALITY = 80

# A cost guard, not a capability limit. Every page is a separate model call
# with an image in it, so a mistakenly uploaded 200-page policy document would
# otherwise be an expensive way to learn that it was the wrong file.
MAX_VISION_PAGES = 12

# --- What a returned box has to clear to be believed -----------------------
#
# All in fractions of the page, because that is what the model answers in.
MIN_BOX_W = 0.01
MIN_BOX_H = 0.004
# A box covering this much of the page is a section heading or the whole form,
# not a field. Stamping an answer into one puts it across half the page.
MAX_BOX_AREA = 0.25
# Slack for a box that runs to the page edge, before clamping. A model that
# says 1.004 means 1; one that says 1.4 has lost the plot.
EDGE_TOLERANCE = 0.02


class VisionUnavailable(Exception):
    """No rasterizer in this environment, so a scan cannot be read."""


def vision_available() -> bool:
    """Whether this deployment can render a page at all.

    PyMuPDF was a calibration-only dependency for most of this project's life
    and is a runtime one now. This is checked rather than assumed so that a
    deployment without it refuses scans the way it always did, instead of
    raising ImportError on the first doctor who uploads one.
    """
    try:
        import pymupdf  # noqa: F401
    except Exception:
        return False
    return True


class RenderedPage:
    def __init__(self, *, number: int, jpeg: bytes, width_pt: float, height_pt: float) -> None:
        self.number = number
        self.jpeg = jpeg
        self.width_pt = width_pt
        self.height_pt = height_pt


def render_pages(data: bytes, max_pages: int = MAX_VISION_PAGES) -> list[RenderedPage]:
    """Every page as a JPEG, with the page's size in POINTS.

    The point size is carried alongside the image and not derived from it: the
    boxes come back as fractions of the page, and what they have to become is
    points. Going via pixels would mean the render resolution leaked into the
    geometry, and a later DPI change would silently move every box.
    """
    try:
        import pymupdf
    except Exception as exc:  # pragma: no cover - environment-dependent
        raise VisionUnavailable("no PDF rasterizer is installed") from exc

    pages: list[RenderedPage] = []
    with pymupdf.open(stream=data, filetype="pdf") as doc:
        for index, page in enumerate(doc, start=1):
            if index > max_pages:
                break
            width_pt = float(page.rect.width)
            height_pt = float(page.rect.height)
            if width_pt <= 0 or height_pt <= 0:
                continue
            zoom = TARGET_LONG_EDGE_PX / max(width_pt, height_pt)
            pixmap = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom))
            pages.append(
                RenderedPage(
                    number=index,
                    jpeg=pixmap.tobytes("jpg", jpg_quality=JPEG_QUALITY),
                    width_pt=width_pt,
                    height_pt=height_pt,
                )
            )
    return pages


VISION_SYSTEM_PROMPT = """\
You are looking at one page of a BLANK medical insurance claim form, scanned \
from paper. It has no patient in it and nothing you are shown is confidential.

Find every place on this page where a doctor or their patient writes an \
answer: ruled lines after a question, empty boxes, tick boxes, table cells \
waiting to be filled. For each one return:

- label: the question as the form prints it, in the form's own words. Short. \
Where one question has several boxes, qualify each: "Date of admission (day)".
- description: one sentence saying precisely what belongs there, as you would \
tell a colleague filling it. Include the format if the form implies one. Empty \
string when the label says everything.
- type: "text", "date", or "checkbox"
- options: for a question answered by choosing from a printed set, those \
answers in the form's own wording. Empty array otherwise.
- x, y, w, h: where the ANSWER goes, as fractions of the page between 0 and 1. \
x and y are the top-left corner of the writing space, measured from the \
top-left corner of the page. NOT the printed question — the empty space next \
to it where the answer is written.

Getting the geometry right matters more than finding everything. What you \
return is stamped onto this page at those coordinates, so a box a little too \
high prints the answer across the printed question above it, and a box that \
spans two questions prints one answer under the wrong heading. If you are not \
confident where a box is, leave it out: a field nobody filled costs the doctor \
a few seconds of handwriting, and a field printed in the wrong place costs \
them the form.

Also leave out:
- anything the INSURER fills, and anything marked "for office use"
- signature lines and the date beside a signature — those are signed by hand \
and a tool must not fill them
- the printed questions themselves, headings, and instructions

Return an empty array if this page has nothing to fill in, which is normal for \
a cover page or a page of instructions.
"""


def _vision_output_schema() -> dict[str, Any]:
    """One flat array of uniform objects.

    Deliberately not a property per field, and not a nested box object: the
    structured-output grammar has hard limits on union-typed parameters and
    total size, which is the trap recorded in CLAUDE.md and the reason
    `mapping.build_output_schema` has the shape it does. Four plain numbers
    cost nothing and nest nothing.
    """
    return {
        "type": "object",
        "properties": {
            "fields": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "label": {"type": "string"},
                        "description": {"type": "string"},
                        "type": {"type": "string", "enum": ["text", "date", "checkbox"]},
                        "options": {"type": "array", "items": {"type": "string"}},
                        "x": {"type": "number"},
                        "y": {"type": "number"},
                        "w": {"type": "number"},
                        "h": {"type": "number"},
                    },
                    "required": ["label", "description", "type", "options", "x", "y", "w", "h"],
                    "additionalProperties": False,
                },
            }
        },
        "required": ["fields"],
        "additionalProperties": False,
    }


def _default_client():
    import anthropic

    return anthropic.Anthropic()


def describe_page(page: RenderedPage, client, model: str = VISION_MODEL) -> list[dict[str, Any]]:
    """What the model says is on one page. A failed page yields nothing.

    Skipped rather than fatal, for the same reason the AcroForm path skips one:
    a schema missing one page of a seven-page form is worth more to the doctor
    than a refusal, and the review screen shows exactly which questions exist.
    """
    response = client.messages.create(
        model=model,
        max_tokens=16000,
        system=VISION_SYSTEM_PROMPT,
        output_config={"format": {"type": "json_schema", "schema": _vision_output_schema()}},
        messages=[
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": "image/jpeg",
                            "data": base64.b64encode(page.jpeg).decode("ascii"),
                        },
                    },
                    {"type": "text", "text": f"Page {page.number} of this form."},
                ],
            }
        ],
    )
    if response.stop_reason in {"refusal", "max_tokens"}:
        return []
    text = next((b.text for b in response.content if b.type == "text"), None)
    if text is None:
        return []
    try:
        raw = json.loads(text)
    except json.JSONDecodeError:
        return []
    fields = raw.get("fields")
    return [f for f in fields if isinstance(f, dict)] if isinstance(fields, list) else []


def _to_box(raw: dict[str, Any], page: RenderedPage) -> FieldBox | None:
    """A returned rectangle as a FieldBox in points, or None if it is not one.

    Every branch here is a refusal, and they exist because the coordinates are
    the one part of this path with nothing behind them but the model's word.
    A wrong label produces a wrong answer that the doctor reads in review; a
    wrong box produces a right answer printed somewhere it does not belong,
    which review cannot show them.
    """
    try:
        x = float(raw["x"])
        y = float(raw["y"])
        w = float(raw["w"])
        h = float(raw["h"])
    except (KeyError, TypeError, ValueError):
        return None

    if not all(map(_finite, (x, y, w, h))):
        return None
    # Off the page entirely, or inside out.
    if x < 0 or y < 0 or w <= 0 or h <= 0:
        return None
    if x >= 1 or y >= 1:
        return None
    # Running past the edge by a hair is rounding; by a lot is a bad answer.
    if x + w > 1 + EDGE_TOLERANCE or y + h > 1 + EDGE_TOLERANCE:
        return None
    w = min(w, 1 - x)
    h = min(h, 1 - y)
    # Too small to write in, or big enough to be a section rather than a field.
    if w < MIN_BOX_W or h < MIN_BOX_H:
        return None
    if w * h > MAX_BOX_AREA:
        return None

    return FieldBox(
        page=page.number,
        x=x * page.width_pt,
        y=y * page.height_pt,
        w=w * page.width_pt,
        h=h * page.height_pt,
    )


def _finite(value: float) -> bool:
    return value == value and value not in (float("inf"), float("-inf"))


def derive_overlay_schema(
    data: bytes,
    form_id: str,
    *,
    display_name: str | None = None,
    insurer: str | None = None,
    pdf_path: str = "",
    client=None,
    model: str = VISION_MODEL,
    max_pages: int = MAX_VISION_PAGES,
) -> FormSchema:
    """A scanned blank form -> an overlay FormSchema.

    **The residual risk, stated rather than buried:** unlike the AcroForm path,
    nothing here can check the geometry. `_to_box` throws out a box that is
    obviously impossible, and a box that is merely 15pt out looks identical to
    a correct one from in here. That is what the proof sheet exists for, and it
    is why this path is not finished when this function returns.
    """
    from demographics import sources_for_labels
    from form_intake import IntakeError, _slug, read_pages_in_parallel

    pages = render_pages(data, max_pages=max_pages)
    if not pages:
        raise IntakeError("That PDF has no pages that could be read.")

    client = client or _default_client()

    # Every page at once. A vision call carries an image and is the slowest
    # thing in this product, so reading a seven-page form in series is seven
    # times the wall clock for no benefit — the pages do not inform each other.
    # See MAX_CONCURRENT_PAGES in form_intake for the cap and what it prevents.
    by_page = read_pages_in_parallel(
        {page.number: page for page in pages},
        lambda _number, page: describe_page(page, client, model),
    )

    found: list[tuple[dict[str, Any], FieldBox]] = []
    for page in pages:
        for raw in by_page.get(page.number) or []:
            label = str(raw.get("label") or "").strip()
            if not label:
                continue
            box = _to_box(raw, page)
            if box is None:
                continue
            found.append((raw, box))

    if not found:
        raise IntakeError(
            "Nothing on that form could be located precisely enough to fill "
            "safely. Send it to us and we will add it by hand."
        )

    # Demographics off the derived label, deterministically, by the helper the
    # live-page and AcroForm paths both use. The model reads the box; it does
    # not decide that a box holds the patient's NRIC.
    sources = sources_for_labels([str(raw["label"]).strip() for raw, _ in found])

    taken: set[str] = set()
    fields: list[FormField] = []
    for (raw, box), source in zip(found, sources):
        kind = str(raw.get("type") or "text")
        if kind not in {"text", "date", "checkbox"}:
            kind = "text"
        options = [str(o) for o in (raw.get("options") or []) if str(o).strip()]
        # On a scan a tick box has no export value to set — overlay_fill draws
        # an X — so a checkbox is a boolean and has nowhere to put a choice.
        if kind == "checkbox":
            options = []

        label = str(raw["label"]).strip()
        fields.append(
            FormField(
                id=_slug(label, taken),
                box=box,
                type=kind,
                source=source,
                label=label,
                description=str(raw.get("description") or "").strip() or None,
                options=options,
            )
        )

    return FormSchema(
        form_id=form_id,
        pdf_path=pdf_path,
        fill_mode="overlay",
        fields=fields,
        display_name=display_name,
        insurer=insurer,
    )
