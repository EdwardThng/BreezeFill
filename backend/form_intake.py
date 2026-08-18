"""Turn an insurer's blank form PDF into a FormSchema, at upload time.

The form bank was hand-authored: someone opened each insurer's PDF, read the
field names out with `pdf_fill.dump_pdf_fields`, and wrote the JSON by hand.
That is the right way to get six forms and the wrong way to get sixty — a
doctor holding a form this repo has never seen has no route at all, and the
forms doctors actually receive are whatever their patient's insurer sends.

So: derive the schema from the PDF itself. This is the same move `_live_schema`
in main.py already makes for a web page — read the controls, name them, hand
the result to the ordinary mapper — with an uploaded PDF as the source instead
of the DOM, and it produces the same `FormSchema` the authored ones do. Nothing
downstream can tell the difference, which is the point: the mapper, the review
screen, the redaction guards and the fill all stay exactly as they are.

WHAT THIS MODULE MAY AND MAY NOT SEND TO THE MODEL
--------------------------------------------------

It sends the blank form: field names, page text, box geometry. A blank insurer
form is a published document with no patient in it, so it goes unredacted, and
that is a deliberate exception rather than an oversight — every other path to
the model in this repo redacts first because it carries a note.

The exception holds only while the form is blank, and `probe_pdf` is what
checks. An uploaded PDF whose fields already have values is somebody's filled
claim, and a filled claim is PHI: it is refused for banking outright, and its
existing values are never read or sent. See `PdfProbe.already_filled`.

Page text is still scrubbed with `scrub_patterns` on the way out. It should
never contain anything to catch — but "should" is doing load-bearing work in
that sentence, and the doctor chose this file, not us.
"""

from __future__ import annotations

import json
import os
import re
from typing import Any

from pypdf import PdfReader
from pypdf.generic import IndirectObject

from demographics import sources_for_labels
from mapping import FormField, FormSchema
from redaction import scrub_patterns

DERIVE_MODEL = os.environ.get("FORMFILL_DERIVE_MODEL", "claude-opus-5")

# A page with fewer characters than this has no usable text layer. Scanned
# forms come back at exactly 0; the threshold is not 0 because a scan with a
# stray text watermark should still be treated as a scan.
MIN_TEXT_CHARS_PER_PAGE = 40

# How far from a widget to look for its label, in points. Roughly one line
# height above and a couple of columns to the left — a label further away than
# this belongs to a different question.
LABEL_REACH_ABOVE = 40.0
LABEL_REACH_LEFT = 260.0
MAX_LABEL_RUNS = 4


class IntakeError(Exception):
    """The upload cannot become a schema. The message is shown to the doctor,
    so it says what to do next — and it names only the form, never a value
    read out of it."""


# ---------------------------------------------------------------------------
# Probing: what kind of PDF is this, before anything is spent on it
# ---------------------------------------------------------------------------


class PdfProbe:
    """What an uploaded PDF is, decided by reading it rather than by asking.

    Three questions, and the answers route the upload:

    - Does it have AcroForm fields? Then its own field names and boxes are the
      truth and the schema is derived from them (`fill_mode="acroform"`).
    - Does it have a text layer? Without fields but with text there is still
      something to read, though nothing to write into.
    - Is it already filled in? Then it is not a blank form and must not be
      banked, whatever else is true of it.
    """

    def __init__(
        self,
        *,
        pages: int,
        widget_count: int,
        text_chars: int,
        already_filled: bool,
        encrypted: bool,
    ) -> None:
        self.pages = pages
        self.widget_count = widget_count
        self.text_chars = text_chars
        self.already_filled = already_filled
        self.encrypted = encrypted

    @property
    def fillable(self) -> bool:
        return self.widget_count > 0

    @property
    def has_text_layer(self) -> bool:
        return self.text_chars >= MIN_TEXT_CHARS_PER_PAGE * max(1, self.pages) / 2

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return (
            f"PdfProbe(pages={self.pages}, widgets={self.widget_count}, "
            f"text_chars={self.text_chars}, already_filled={self.already_filled})"
        )


def probe_pdf(data: bytes) -> PdfProbe:
    """Read an uploaded PDF's shape without interpreting its contents."""
    import io

    try:
        reader = PdfReader(io.BytesIO(data))
    except Exception as exc:  # pypdf raises a wide family on malformed input
        raise IntakeError("That file could not be read as a PDF.") from exc

    if reader.is_encrypted:
        # Try the empty password, which is what "encrypted for printing only"
        # means in practice and is most of what clinics receive.
        try:
            if not reader.decrypt(""):
                return PdfProbe(
                    pages=0, widget_count=0, text_chars=0,
                    already_filled=False, encrypted=True,
                )
        except Exception:
            return PdfProbe(
                pages=0, widget_count=0, text_chars=0,
                already_filled=False, encrypted=True,
            )

    try:
        fields = reader.get_fields() or {}
    except Exception:
        fields = {}

    # A value on any field means this is somebody's filled claim, not a blank
    # form. Checked by presence, never by reading what the value says.
    already_filled = any(
        _has_value(field) for field in fields.values() if isinstance(field, dict)
    )

    text_chars = 0
    for page in reader.pages:
        try:
            text_chars += len((page.extract_text() or "").strip())
        except Exception:
            continue

    return PdfProbe(
        pages=len(reader.pages),
        widget_count=len(fields),
        text_chars=text_chars,
        already_filled=already_filled,
        encrypted=False,
    )


def _has_value(field: dict[str, Any]) -> bool:
    value = field.get("/V")
    if value is None:
        return False
    text = str(value).strip()
    # "/Off" is a checkbox in its default state, not an answer.
    return bool(text) and text != "/Off"


# The refusal for a form this cannot read. It is deliberately specific about
# WHY, because "unsupported" tells a doctor holding a form nothing about
# whether to try a different file or give up — and most of the time a fillable
# version of the same form exists on the insurer's website.
SCANNED_REFUSAL = (
    "This form is a scan — an image of a page, with no fillable boxes and no "
    "text to read. BreezeFill cannot map it yet. Check the insurer's website "
    "for a fillable version of the same form, which usually exists, or send "
    "this one to us and we will add it."
)


def refusal_for(probe: PdfProbe, can_render: bool = False) -> str | None:
    """Why this upload cannot be mapped, or None if it can.

    Returned rather than raised: the caller shows it to the doctor, and a
    refusal here is an ordinary answer about an ordinary file, not a fault.

    `can_render` says whether this deployment has a rasterizer, which is what
    decides the fate of a form with no fillable boxes. With one, the page is
    rendered and read by `vision_intake`; without one there is nothing left to
    try. It defaults to False so that the refusal is what happens when nobody
    has thought about it — a wrong refusal costs a doctor a form, and a wrong
    acceptance costs them a stamped-on page they cannot see is wrong.
    """
    if probe.encrypted:
        return (
            "This PDF is password-protected, so it cannot be opened to read "
            "its fields. Save an unprotected copy and upload that."
        )
    if probe.pages == 0:
        return "That PDF has no pages in it."
    if probe.fillable:
        return None
    if can_render:
        # No boxes and no text is a scan, which is now a path rather than a
        # dead end. No boxes but text present is a flat digital form, and the
        # same treatment reads it.
        return None
    if not probe.has_text_layer:
        return SCANNED_REFUSAL
    # Readable but not writable. Worth its own message: the doctor can see
    # text on the page, so "it's a scan" would read as plainly wrong.
    return (
        "This form has no fillable boxes — the text is there, but there is "
        "nowhere to write an answer. BreezeFill can only fill forms with "
        "form fields in them, for now. Check the insurer's website for a "
        "fillable version, or send this one to us and we will add it."
    )


# ---------------------------------------------------------------------------
# Reading the widgets, and the text sitting next to them
# ---------------------------------------------------------------------------


class Widget:
    """One AcroForm control, with the page text near enough to name it.

    `nearby` is the whole reason this class exists. A real insurer form's field
    names are not labels and frequently are not anything: Great Eastern's own
    GHS form has `undefined_2`, and three separate boxes called `Day`, `Month`
    and `Year` that appear four times over on different questions. What the box
    is for is printed on the page beside it, so that is what gets read.
    """

    def __init__(
        self,
        *,
        name: str,
        kind: str,
        page: int,
        rect: tuple[float, float, float, float],
        states: list[str],
        nearby: list[str],
    ) -> None:
        self.name = name
        self.kind = kind
        self.page = page
        self.rect = rect
        self.states = states
        self.nearby = nearby


def _positioned_text(page, page_height: float) -> list[tuple[float, float, str]]:
    """Every text run on the page as (x, y, text), y measured from the TOP.

    Top-left origin because that is the frame the widget rectangles get
    converted into below, and because it is the frame `overlay_fill` uses. One
    conversion, in one place, is the whole trick to not getting this wrong.
    """
    runs: list[tuple[float, float, str]] = []

    def visit(text, cm, tm, font_dict, font_size):  # noqa: ANN001 - pypdf callback
        cleaned = " ".join(str(text).split())
        if cleaned:
            runs.append((float(tm[4]), page_height - float(tm[5]), cleaned))

    try:
        page.extract_text(visitor_text=visit)
    except Exception:
        return []
    return runs


def _nearby_runs(
    runs: list[tuple[float, float, str]],
    x: float,
    y: float,
    w: float,
    h: float,
) -> list[str]:
    """The text most likely to be this box's label: same line to the left
    first, then the line above. Ordered by distance, nearest first."""
    centre = y + h / 2
    scored: list[tuple[int, float, str]] = []
    for tx, ty, text in runs:
        if abs(ty - centre) < max(h, 8.0) * 1.4 and tx < x:
            if x - tx <= LABEL_REACH_LEFT:
                scored.append((0, x - tx, text))
        elif 0 < y - ty <= LABEL_REACH_ABOVE and abs(tx - x) <= LABEL_REACH_LEFT:
            scored.append((1, y - ty, text))
    scored.sort(key=lambda item: (item[0], item[1]))

    seen: set[str] = set()
    out: list[str] = []
    for _, _, text in scored:
        if text not in seen:
            seen.add(text)
            out.append(text)
        if len(out) >= MAX_LABEL_RUNS:
            break
    return out


def read_widgets(data: bytes) -> tuple[list[Widget], dict[int, str]]:
    """Every AcroForm control in the PDF, and each page's full text.

    Both halves go to the model: the nearby runs say which question a box
    belongs to, and the page text says what the question actually asks, which
    is often a sentence the box is nowhere near.
    """
    import io

    reader = PdfReader(io.BytesIO(data))
    if reader.is_encrypted:
        reader.decrypt("")

    fields = reader.get_fields() or {}
    widgets: list[Widget] = []
    page_text: dict[int, str] = {}

    for index, page in enumerate(reader.pages, start=1):
        height = float(page.mediabox.height)
        page_text[index] = scrub_patterns((page.extract_text() or "").strip())
        runs = _positioned_text(page, height)

        annots = page.get("/Annots")
        if annots is None:
            continue
        if isinstance(annots, IndirectObject):
            annots = annots.get_object()

        for ref in annots:
            try:
                obj = ref.get_object()
            except Exception:
                continue
            if obj.get("/Subtype") != "/Widget":
                continue

            holder = obj if "/T" in obj else None
            if holder is None and "/Parent" in obj:
                holder = obj["/Parent"].get_object()
            if holder is None:
                continue

            name = str(holder.get("/T") or "").strip()
            if not name or name not in fields:
                continue

            try:
                x0, y0, x1, y1 = (float(v) for v in obj["/Rect"])
            except Exception:
                continue
            x, w = min(x0, x1), abs(x1 - x0)
            top, h = height - max(y0, y1), abs(y1 - y0)

            declared = fields.get(name, {})
            states = [
                str(s) for s in (declared.get("/_States_") or []) if str(s) != "/Off"
            ]

            widgets.append(
                Widget(
                    name=name,
                    kind=str(declared.get("/FT") or holder.get("/FT") or "/Tx"),
                    page=index,
                    rect=(x, top, w, h),
                    states=states,
                    nearby=[scrub_patterns(run) for run in _nearby_runs(runs, x, top, w, h)],
                )
            )

    return widgets, page_text


# ---------------------------------------------------------------------------
# Naming the widgets
# ---------------------------------------------------------------------------

DERIVE_SYSTEM_PROMPT = """\
You are reading a BLANK medical insurance claim form and describing its boxes \
so that a form-filling tool can use it. The form has no patient in it; nothing \
you are shown is confidential.

You will be given one page of the form: its full printed text, and a list of \
the fillable boxes on it. Each box carries the name the PDF gives it — often \
meaningless, like "undefined_2" or "Text5" — its type, and the printed text \
nearest to it on the page.

Return one entry per box, in the order given, with:
- ref: the box's ref, copied exactly
- label: what a doctor would call this box, in the form's own words. Short. \
Use the printed text, never the PDF's internal name. When several boxes share \
one question, qualify each: "Date of admission (day)", "Sex: Male".
- description: one sentence saying precisely what belongs in this box, as you \
would tell a colleague filling it. Include the format when the form implies \
one. Empty string if the label already says everything.
- type: "text", "date", or "checkbox"
- options: for a box that accepts only certain answers, those answers in the \
form's own wording. Empty array otherwise.
- include: true if a doctor or their patient fills this box in. false for \
boxes the INSURER fills, boxes marked "for office use", and boxes that are \
part of the form's own administration rather than the claim.

Rules:
- Never invent a label. If the printed text near a box does not say what it is \
for, and the page text does not either, set include to false rather than \
guessing. A box with a wrong label gets a wrong value written into it, and the \
doctor signs the result.
- A box asking for a signature or a date of signing is include: false. Those \
are signed by hand, and a tool must not fill them.
- Keep the form's own wording for options, character for character.
"""


def _derive_output_schema(refs: list[str]) -> dict[str, Any]:
    """Structured-output schema for one page of boxes.

    One shared item definition with the refs as an enum, not a property per
    box — the same shape `mapping.build_output_schema` uses and for the same
    reason: a per-box object blows the grammar limits on a real form, and this
    module routinely sees sixty boxes on a page.
    """
    return {
        "type": "object",
        "properties": {
            "boxes": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "ref": {"type": "string", "enum": refs},
                        "label": {"type": "string"},
                        "description": {"type": "string"},
                        "type": {"type": "string", "enum": ["text", "date", "checkbox"]},
                        "options": {"type": "array", "items": {"type": "string"}},
                        "include": {"type": "boolean"},
                    },
                    "required": [
                        "ref", "label", "description", "type", "options", "include",
                    ],
                    "additionalProperties": False,
                },
            }
        },
        "required": ["boxes"],
        "additionalProperties": False,
    }


def _page_prompt(widgets: list[Widget], page_text: str, page: int) -> str:
    lines = [f"<page number=\"{page}\">", "<printed_text>", page_text, "</printed_text>", "<boxes>"]
    for index, widget in enumerate(widgets):
        kind = {"/Btn": "checkbox", "/Ch": "choice"}.get(widget.kind, "text")
        lines.append(
            f'<box ref="b{index}" pdf_name="{widget.name}" type="{kind}"'
            f' nearby="{" | ".join(widget.nearby)}"'
            + (f' accepts="{" | ".join(widget.states)}"' if widget.states else "")
            + " />"
        )
    lines.append("</boxes>")
    lines.append("</page>")
    return "\n".join(lines)


def _default_client():
    import anthropic

    return anthropic.Anthropic()


def _describe_page(
    widgets: list[Widget], page_text: str, page: int, client, model: str
) -> dict[str, dict[str, Any]]:
    """One call per page. Returns {ref: description dict} for what came back.

    A page whose call fails is skipped rather than fatal: a schema missing one
    page of a seven-page form is still worth more to the doctor than a refusal,
    and the review screen shows exactly which fields exist.
    """
    refs = [f"b{i}" for i in range(len(widgets))]
    response = client.messages.create(
        model=model,
        max_tokens=16000,
        system=DERIVE_SYSTEM_PROMPT,
        output_config={"format": {"type": "json_schema", "schema": _derive_output_schema(refs)}},
        messages=[{"role": "user", "content": _page_prompt(widgets, page_text, page)}],
    )
    if response.stop_reason in {"refusal", "max_tokens"}:
        return {}
    text = next((b.text for b in response.content if b.type == "text"), None)
    if text is None:
        return {}
    try:
        raw = json.loads(text)
    except json.JSONDecodeError:
        return {}

    out: dict[str, dict[str, Any]] = {}
    for item in raw.get("boxes") or []:
        if isinstance(item, dict) and isinstance(item.get("ref"), str):
            out.setdefault(item["ref"], item)
    return out


def _slug(label: str, taken: set[str]) -> str:
    base = re.sub(r"[^a-z0-9]+", "_", label.lower()).strip("_")[:40] or "field"
    candidate, n = base, 2
    while candidate in taken:
        candidate, n = f"{base}_{n}", n + 1
    taken.add(candidate)
    return candidate


def derive_schema(
    data: bytes,
    form_id: str,
    *,
    display_name: str | None = None,
    insurer: str | None = None,
    pdf_path: str = "",
    client=None,
    model: str = DERIVE_MODEL,
) -> FormSchema:
    """An uploaded fillable PDF -> a FormSchema the ordinary mapper can use.

    `pdf_path` is where the blank form will live once banked. It is passed in
    rather than worked out here because this module does not decide storage,
    and a schema pointing at a file nobody wrote is the kind of untrue field
    that later gets believed.
    """
    widgets, page_text = read_widgets(data)
    if not widgets:
        raise IntakeError(
            "No fillable boxes were found in that PDF, so there is nothing to map."
        )

    client = client or _default_client()

    by_page: dict[int, list[Widget]] = {}
    for widget in widgets:
        by_page.setdefault(widget.page, []).append(widget)

    described: list[tuple[Widget, dict[str, Any]]] = []
    for page in sorted(by_page):
        page_widgets = by_page[page]
        answers = _describe_page(
            page_widgets, page_text.get(page, ""), page, client, model
        )
        for index, widget in enumerate(page_widgets):
            answer = answers.get(f"b{index}")
            if answer and answer.get("include") and str(answer.get("label", "")).strip():
                described.append((widget, answer))

    if not described:
        raise IntakeError(
            "None of the boxes in that PDF could be identified well enough to "
            "fill safely. Send it to us and we will add it by hand."
        )

    # Demographics are resolved from the DERIVED label, deterministically, by
    # the same helper the live-page path uses. The model names the box; it does
    # not get to decide that a box holds the patient's NRIC.
    sources = sources_for_labels([answer["label"] for _, answer in described])

    taken: set[str] = set()
    fields: list[FormField] = []
    for (widget, answer), source in zip(described, sources):
        kind = str(answer.get("type") or "text")
        if kind not in {"text", "date", "checkbox"}:
            kind = "text"
        # The PDF's own type wins over the model's opinion of it: writing a
        # string into a checkbox raises in pdf_fill, and the PDF knows.
        if widget.kind == "/Btn":
            kind = "checkbox"
        elif kind == "checkbox":
            kind = "text"

        options = [str(o) for o in (answer.get("options") or []) if str(o).strip()]
        # A checkbox is a boolean to pdf_fill — it is set to the field's own
        # export value or /Off, and there is nowhere to put a chosen string.
        if kind == "checkbox":
            options = []

        label = str(answer["label"]).strip()
        fields.append(
            FormField(
                id=_slug(label, taken),
                pdf_field_name=widget.name,
                type=kind,
                source=source,
                label=label,
                description=str(answer.get("description") or "").strip() or None,
                options=options,
            )
        )

    return FormSchema(
        form_id=form_id,
        pdf_path=pdf_path,
        fill_mode="acroform",
        fields=fields,
        display_name=display_name,
        insurer=insurer,
    )
