"""FastAPI app: map a note onto a form's fields, and fill the form.

**Every route here is stateless.** The server holds nothing between requests —
no claim store, no session, no id to purge — so patient data exists only for
the duration of the request that carried it in. Retention is zero rather than
bounded.

It was not always so. The website used to review on one screen and download
from another, and something had to hold the rows in between: an in-memory
claim store with a one-hour TTL. That store was also the reason this app could
never run on more than one machine — a claim created on machine A 404s when
approve lands on machine B — which made `--ha=false` load-bearing and ruled
out any serverless host.

The extension never needed it (the panel that reviews the rows is the panel
that writes them), and the website does not either: the review screen already
holds every value, so it can send them all to `POST /forms/{id}/pdf` in one
request. Removing the store deleted the retention window, the HA trap and the
purge timer together. Do not reintroduce it — a shared store would be a
database holding patient data, which is a thing this product says publicly it
does not have.

Other rules enforced here:
- No patient data in logs or error messages.
- Nothing patient-related touches disk, ever.
"""

from __future__ import annotations

import io
import logging
import os
import re
import zipfile
from collections import Counter
from pathlib import Path

import anthropic
from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from demographics import (
    ParsedDemographics,
    demographic_field_for_label,
    parse_demographics,
)
from mapping import (
    FormField,
    FormSchema,
    MappingError,
    assemble_claim,
    assemble_redacted,
    llm_sweep,
    load_form_schema,
    map_fields,
    MappedField,
)
from overlay_fill import OverlayFillError, overlay_fill
from pdf_fill import PdfFillError, fill_pdf
from redaction import PatientRecord, redact, scrub_patterns
from redaction import _pass2_patterns, _pass3_llm_sweep

REPO_ROOT = Path(__file__).resolve().parent.parent
SCHEMAS_DIR = Path(__file__).resolve().parent / "schemas"
FRONTEND_DIR = REPO_ROOT / "frontend" / "dist"

# Exception *types* only ever reach this. See _review_rows: a message or
# traceback can quote the clinical text that caused it.
logger = logging.getLogger("formfill")

app = FastAPI(title="FormFill", version="0.1.0")
# Comma-separated list of extra allowed origins, e.g. the deployed frontend URL.
_extra_origins = [
    o.strip()
    for o in os.environ.get("FORMFILL_ALLOWED_ORIGINS", "").split(",")
    if o.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173", *_extra_origins],
    # The extension calls from chrome-extension://<id>, and the id is only
    # stable once the extension is packed or pinned with a manifest key — a
    # dev-mode load gets a different one on every machine. Note this is not an
    # access control and must not be mistaken for one: CORS is enforced by
    # browsers, and anything that is not a browser ignores it entirely.
    allow_origin_regex=r"chrome-extension://[a-p]{32}",
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Form schema registry
# ---------------------------------------------------------------------------


def _load_schemas() -> dict[str, FormSchema]:
    schemas: dict[str, FormSchema] = {}
    for path in sorted(SCHEMAS_DIR.glob("*.json")):
        schema = load_form_schema(path)
        schemas[schema.form_id] = schema
    return schemas


FORM_SCHEMAS = _load_schemas()


def _get_schema(form_id: str) -> FormSchema:
    schema = FORM_SCHEMAS.get(form_id)
    if schema is None:
        raise HTTPException(status_code=404, detail=f"unknown form_id: {form_id}")
    return schema


# ---------------------------------------------------------------------------
# Request/response models
# ---------------------------------------------------------------------------


class CreateClaimRequest(BaseModel):
    form_id: str
    patient: PatientRecord


class MapResponse(BaseModel):
    """The review rows. No id, because there is nothing to refer back to —
    the caller holds these until it is ready to fill something with them."""

    form_id: str
    fields: list[MappedField]


class ParseRequest(BaseModel):
    text: str
    # The name the doctor typed before pasting anything.
    #
    # Not a hint and not an answer to be improved on: it is what turns finding
    # the name in the block from a guess into a check. The panel asks for it
    # first precisely because redaction cannot find a name by shape, so it is
    # always known by the time a paste exists — and with it in hand, the piece
    # of a header that is the patient is the piece that equals it, and the
    # piece next to it belongs to somebody else.
    #
    # Optional, because a caller that is not the panel may not have one. Then
    # the parser falls back to reading a name out of the block, under the
    # fences in `_looks_like_a_name`.
    full_name: str = ""


class LiveField(BaseModel):
    """One control read off the page in front of the doctor.

    Not only for a page nobody has a schema for any more. The panel maps the
    live page every time and enriches each control with the matching schema
    field where one exists, so a single request can carry both — a question
    the bank describes, and the one next to it that it does not.
    """

    label: str
    # The DOM's own type, normalised below. Anything unrecognised is text.
    type: str = "text"
    # The instruction from the schema field that matched this control, when one
    # did. This is the whole difference between a page's own wording ("7. When
    # did the patient first consult you") and the instruction a colleague would
    # be given ("the date the patient FIRST consulted this doctor for this
    # condition, not the latest visit"). Absent means no schema claimed this
    # control and its label is all there is.
    description: str | None = None
    # The answers the control accepts, read off the control itself. Empty for a
    # free-text box, and empty when the browser withheld the list because it
    # looked like claim data rather than choices.
    options: list[str] = []
    # Which repeating entry this control belongs to, 1-based, or None.
    #
    # A question the doctor can answer several times renders as repeated
    # containers, one per entry, each holding the same sub-questions. The
    # index comes from the DOM's shape, never from the sub-header naming the
    # entry — that is prose, and prose is unreadable by rule because a name
    # has no shape for the scrubber to find.
    #
    # Nothing here knows what the question is ABOUT. The mechanism is purely
    # structural and must stay that way: no clinical vocabulary belongs in it.
    instance: int | None = None


class MapRedactedRequest(BaseModel):
    """A page's questions, and a note this server was never trusted with.

    The extension redacts in the browser now, so what arrives here is already
    `[PATIENT] presents with…`. There is no PatientRecord on this request and
    there is nowhere to put one: the name, NRIC, date of birth, phone, address
    and policy number never leave the tab, and the map from token back to real
    value never leaves it either.

    What that costs the server is the ability to fill a demographic field or to
    re-merge an answer, and both jobs move to the caller. What it buys is that
    a log, a crash dump or a future misconfiguration here cannot contain a
    patient's name, because one was never received.
    """

    fields: list[LiveField]
    # Redacted before it was sent. Scrubbed again on arrival — see the route.
    redacted_text: str


class MapLiveRequest(BaseModel):
    fields: list[LiveField]
    patient: PatientRecord


class FillPdfRequest(BaseModel):
    """The doctor's final values, keyed by field_id.

    Every field the caller wants filled must be here. There is no server-side
    copy to fall back on — that is the point — so an omitted field is a blank
    one. The review screen already holds every row, so it sends every row.
    """

    values: dict[str, str | bool | None] = {}


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@app.get("/forms")
def list_forms() -> list[dict]:
    """Forms offered in the picker — internal fixtures are excluded.

    FORMFILL_SHOW_INTERNAL=1 puts them back, which is the only way to reach a
    test schema from the extension: the panel fills the picker from this
    endpoint and has no other way to name a form. Read per request rather than
    at import so a test can toggle it, and unset in every environment a doctor
    will ever touch — a fake form in the picker is a form someone can file.
    """
    show_internal = bool(os.environ.get("FORMFILL_SHOW_INTERNAL"))
    return [
        {
            "form_id": s.form_id,
            "display_name": s.display_name or s.form_id,
            "insurer": s.insurer or "",
            # The extension matches the tab's host against these so the doctor
            # is not asked which form they are looking at.
            "hosts": s.hosts,
            "fields": [
                {
                    "id": f.id,
                    "type": f.type,
                    "source": f.source,
                    "label": f.display_label,
                    "description": f.description,
                    # Identification is scored per step, because a wizard only
                    # ever has one step in the DOM: a schema whose fields are
                    # spread over four of them would otherwise score against a
                    # page carrying a quarter of them and be dismissed as the
                    # wrong form. Absent for a form that shows everything at
                    # once, which then scores as one group — today's behaviour.
                    "step": f.step,
                }
                for f in s.fields
            ],
        }
        for s in FORM_SCHEMAS.values()
        if show_internal or not s.internal
    ]


@app.post("/parse", response_model=ParsedDemographics)
def parse_paste(request: ParseRequest) -> ParsedDemographics:
    """One pasted block -> a draft of the demographic fields.

    Patterns only, no model — see demographics.py for why that is the privacy
    model rather than a preference. Nothing is stored and nothing is logged:
    this is the one place the server sees the paste before redaction has a
    dictionary to work with, so it holds it for exactly the length of the
    call. The doctor corrects the result before it is used for anything.

    It lives on the server rather than in the panel so that there is one
    definition of what an NRIC looks like. A JavaScript copy of redaction.py's
    patterns that drifted from the Python one is a leak, and the same reasoning
    keeps redaction itself server-side today.
    """
    return parse_demographics(request.text, known_name=request.full_name)


def _review_rows(schema: FormSchema, patient: PatientRecord) -> list[MappedField]:
    """redact -> map -> re-merge. The shared middle of both fill targets.

    Kept as one function on purpose: the redaction step is the guardrail, and
    a second caller that reimplemented this is exactly how a path that skips
    redaction gets introduced.
    """
    sweep = None if os.environ.get("FORMFILL_DISABLE_SWEEP") else llm_sweep
    try:
        result = redact(patient, llm_sweep=sweep)
        answers = map_fields(schema, result.redacted_text)
    except MappingError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except (anthropic.APIError, anthropic.APIConnectionError) as exc:
        # Generic detail on purpose: no clinical text in errors or logs.
        raise HTTPException(status_code=502, detail="LLM call failed") from exc
    except Exception as exc:
        # Anything else at the LLM boundary must still leave as an
        # HTTPException. A missing or malformed API key raises a plain
        # TypeError from the SDK ("Could not resolve authentication method"),
        # which is not an anthropic.APIError — and an uncaught exception is
        # rendered by Starlette's error handler, which sits OUTSIDE the CORS
        # middleware. The response then carries no CORS headers at all, so the
        # browser reports an opaque "Failed to fetch" with no status code and
        # the extension cannot tell a server crash from a dead host.
        #
        # Log the exception's type and nothing else: a message or traceback can
        # quote the input that caused it, and the input here is clinical text.
        logger.error("mapping failed: %s", type(exc).__name__)
        if not os.environ.get("ANTHROPIC_API_KEY"):
            raise HTTPException(
                status_code=503,
                detail="This server has no ANTHROPIC_API_KEY configured.",
            ) from exc
        raise HTTPException(status_code=502, detail="LLM call failed") from exc

    return assemble_claim(schema, patient, answers, result.redaction_map)


@app.post("/map", response_model=MapResponse)
def map_claim(request: CreateClaimRequest) -> MapResponse:
    """Stateless mapping, for the browser extension.

    The PDF path needs a server-side claim because the doctor reviews on one
    page and downloads from another, so something must hold the rows in
    between. The extension has no such gap: the panel that receives these rows
    is the same surface that reviews them and the same surface that writes them
    into the portal, all in the doctor's browser.

    So this endpoint stores nothing. There is no claim id, nothing to purge,
    and no window during which the server holds a half-finished claim. The
    request is handled and forgotten; retention is zero rather than one hour.
    """
    schema = _get_schema(request.form_id)
    return MapResponse(form_id=schema.form_id, fields=_review_rows(schema, request.patient))


# The structured-output grammar has a bounded total size, and a live page can
# carry far more controls than any insurer form has questions. Refused rather
# than truncated: a silently dropped field looks exactly like a field the model
# had nothing to say about.
MAX_LIVE_FIELDS = 50


def _slug(label: str, taken: set[str]) -> str:
    """A field id from a label. Must be stable and unique — these become the
    enum the model answers against."""
    base = re.sub(r"[^a-z0-9]+", "_", label.lower()).strip("_")[:40] or "field"
    candidate, n = base, 2
    while candidate in taken:
        candidate, n = f"{base}_{n}", n + 1
    taken.add(candidate)
    return candidate


def _entry_label(field: LiveField) -> str:
    """The control's label, qualified by which repeating entry it belongs to.

    A sub-question repeats once per entry, so on a page with three entries the
    bare label names three different controls. That breaks two
    things at once: `_slug` would collide the ids the model answers against,
    and the matcher would call every one of them ambiguous and fill none.

    The qualifier is a NUMBER, synthesised here from the DOM's shape. It is
    deliberately not the sub-header the doctor reads on screen — that heading
    is prose, and prose is the one surface learn mode may not read, because a
    name has no shape for the scrubber to catch.
    """
    if field.instance is None:
        return field.label
    return f"{field.label} (entry {field.instance})"


def _live_sources(fields: list[LiveField]) -> list[str]:
    """Which of the page's controls are asking for a demographic, by index.

    Without this every live control was `source="llm"`, and the consequence was
    not a weaker answer but no answer at all. The demographics are exactly what
    redaction strips out first, so the model reads `[PATIENT]` and `[NRIC]` and
    correctly reports `missing` — while the value sat in the PatientRecord the
    whole time, typed by the doctor two steps earlier. The patient's name is
    the clearest case: it is required at step 1, so it is ALWAYS known, and it
    was the one field guaranteed to be left blank.

    Three rules, all of them refusals:

    - A label resolves only through `demographic_field_for_label`, which is
      exact against the shared alias table. An unrecognised label stays `llm`.
    - **A repeating entry is never demographic.** `instance` means the question
      is asked once per entry — several dependants, several admissions — and
      one patient record cannot answer the second one. These stay `llm`.
    - **Two controls wanting the same demographic yields neither.** A form with
      "Name" in the patient block and "Name" again in the physician block gives
      no way to tell which is which from the label alone, and filling both puts
      the patient's name in the doctor's box. The same refusal `locate.js`
      makes over three identical "Date Of Birth" labels.

    The privacy property is unchanged and worth stating, because this looks
    like it moves data toward the model and does the opposite: a demographic
    field is answered by `assemble_claim` copying from the record, so marking a
    control demographic REMOVES its question from the mapping call.
    """
    resolved: list[str | None] = [
        None
        if field.instance is not None
        else demographic_field_for_label(field.label)
        for field in fields
    ]

    seen = Counter(name for name in resolved if name)
    return [
        f"demographics.{name}" if name and seen[name] == 1 else "llm"
        for name in resolved
    ]


def _live_schema(fields: list[LiveField]) -> FormSchema:
    """The page's controls, as a schema for one request only.

    Each field is as strong as the evidence behind it, and the two cases are
    genuinely different:

    - A control a schema field matched arrives with that field's
      `description` — the instruction a colleague would be given ("the date
      the patient FIRST consulted this doctor for this condition, not the
      latest visit"). This is as good as the schema path, because it *is* the
      schema, applied to the control actually on screen.
    - A control nothing matched has only the question as the page words it.
      Weaker, unavoidably, and it is why a draft schema is still offered
      afterwards: the second claim on this form should be better informed than
      the first.

    Mixing them in one request is the point. The alternative — refusing the
    whole page because the bank does not describe all of it — leaves the
    doctor filling by hand a form the product could have half-filled
    correctly, and they have to submit it either way.
    """
    taken: set[str] = set()
    # A grouped question is a checkbox-typed field carrying options, and
    # `_coerce_answer` consults options before type — so the model answers with
    # the option's own wording rather than true/false. A lone checkbox has no
    # options and stays a plain boolean toggle.
    types = {
        "checkbox": "checkbox",
        "radio-group": "checkbox",
        "checkbox-group": "checkbox",
        "date": "date",
    }
    sources = _live_sources(fields)

    return FormSchema(
        form_id="__live__",
        fill_mode="web",
        fields=[
            FormField(
                id=_slug(_entry_label(field), taken),
                type=types.get(field.type.lower(), "text"),
                source=sources[index],
                # Scrubbed a second time. The extension already ran the same
                # patterns before this left the browser; a label reaches the
                # model only if both passes missed it.
                label=scrub_patterns(_entry_label(field)),
                # The schema's instruction when there is one, the page's own
                # words when there is not. Scrubbed either way: a description
                # is authored in this repo and needs no cleaning, but the
                # merge that fills this in runs in the panel, and a bug there
                # that let page text through would otherwise reach the model
                # unscrubbed.
                description=scrub_patterns(field.description or field.label),
                # Constrains the answer to something the control will accept,
                # exactly as an authored schema's options do — and these come
                # from the control itself, so they cannot be out of date.
                options=[scrub_patterns(o) for o in field.options if o.strip()],
            )
            for index, field in enumerate(fields)
            if field.label.strip()
        ],
    )


@app.post("/map-redacted", response_model=MapResponse)
def map_redacted(request: MapRedactedRequest) -> MapResponse:
    """Map a note this server was never given the identifiers for.

    The route the extension uses. The browser parsed the demographics, built
    the redaction dictionary and applied it before sending, so what arrives is
    already tokenised and there is no PatientRecord to accompany it.

    THE SERVER REDACTS AGAIN ANYWAY, and the second pass is not ceremony. It
    is the backstop for the one real risk in moving redaction into the browser:
    a pattern the JavaScript copy misses. If that happens, the identifier
    reaches this process — which is a bug — but it does not reach the model,
    which is the difference between a defect and a disclosure. Both passes read
    the same shapes out of extension/privacy/patterns.json, so the backstop can
    only fail in the same way the browser did if somebody edits one file.

    Nothing found by either pass is returned. The map built here is a local
    variable for the length of one request; the caller's own map is the only
    one that can turn a token back into a name, and it is in their tab.
    """
    schema = _live_schema(request.fields)
    if not schema.fields:
        raise HTTPException(status_code=422, detail="no labelled fields on this page")
    if len(schema.fields) > MAX_LIVE_FIELDS:
        raise HTTPException(
            status_code=413,
            detail=f"too many fields to map in one call ({len(schema.fields)} > {MAX_LIVE_FIELDS})",
        )

    # Backstop, then the sweep. The map is deliberately discarded: an entry in
    # it is an identifier the browser missed, and handing those back would put
    # them on the wire a second time to no purpose.
    backstop: dict[str, str] = {}
    text = _pass2_patterns(request.redacted_text, backstop)
    if not os.environ.get("FORMFILL_DISABLE_SWEEP"):
        text = _pass3_llm_sweep(text, backstop, llm_sweep)

    try:
        answers = map_fields(schema, text)
    except MappingError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except (anthropic.APIError, anthropic.APIConnectionError) as exc:
        raise HTTPException(status_code=502, detail="LLM call failed") from exc
    except Exception as exc:
        # Same reasoning as _review_rows: the type only, never the message,
        # and always an HTTPException so the response keeps its CORS headers.
        logger.error("mapping failed: %s", type(exc).__name__)
        if not os.environ.get("ANTHROPIC_API_KEY"):
            raise HTTPException(
                status_code=503,
                detail="This server has no ANTHROPIC_API_KEY configured.",
            ) from exc
        raise HTTPException(status_code=502, detail="LLM call failed") from exc

    return MapResponse(form_id=schema.form_id, fields=assemble_redacted(schema, answers))


@app.post("/map-live", response_model=MapResponse)
def map_live(request: MapLiveRequest) -> MapResponse:
    """Map against the page's own controls, with no schema at all.

    The fallback for a form the bank does not have. Same redaction, same review
    rows, same confirm-before-write: what changes is only where the field list
    came from, and therefore how much the model knows about each question.

    The cost is real and was accepted deliberately: **page structure becomes an
    LLM input on every claim mapped this way**, which the schema path avoids
    entirely. Labels are scrubbed twice before they get here, but the scrubber
    finds identifiers by shape and a name has none — so a portal that renders
    the patient's name into a field label defeats it. Prefer a schema; this
    exists so that an unknown form is fillable at all, and so that filling one
    produces the schema that replaces it.
    """
    schema = _live_schema(request.fields)
    if not schema.fields:
        raise HTTPException(status_code=422, detail="no labelled fields on this page")
    if len(schema.fields) > MAX_LIVE_FIELDS:
        # 413 rather than another 422, so the panel can tell these two apart
        # without reading the body. It must not read the body: FastAPI's own
        # validation failures are also 422 and quote the offending input, and
        # the input here includes the clinical text. A status code carries no
        # payload, which is the whole point of keying messages on one.
        raise HTTPException(
            status_code=413,
            detail=f"too many fields to map in one call ({len(schema.fields)} > {MAX_LIVE_FIELDS})",
        )
    return MapResponse(form_id=schema.form_id, fields=_review_rows(schema, request.patient))


@app.post("/forms/{form_id}/pdf")
def fill_form_pdf(form_id: str, request: FillPdfRequest) -> Response:
    """Final values in, filled PDF out. One request, nothing kept.

    The schema — not a stored claim — is what says how each field is addressed:
    an AcroForm field by the PDF's own name, an overlay field by its box. That
    is why this needs no memory of the mapping call that produced the values.
    """
    schema = _get_schema(form_id)

    # A web form has no PDF to return: the extension writes the values into the
    # insurer's own page and the doctor submits it there. Refused explicitly
    # rather than left to fail on a missing pdf_path, so the reason is legible.
    if schema.fill_mode == "web":
        raise HTTPException(
            status_code=422,
            detail="this form is filled in the browser, not downloaded as a PDF",
        )

    # A field id that is not in the schema is a caller bug — most likely a
    # stale build posting against a form that has since changed. Better a 422
    # than a PDF that silently omits it.
    unknown = sorted(set(request.values) - {field.id for field in schema.fields})
    if unknown:
        raise HTTPException(status_code=422, detail=f"unknown field ids: {unknown}")

    by_id = {field.id: request.values.get(field.id) for field in schema.fields}

    pdf_path = (REPO_ROOT / schema.pdf_path).resolve()
    try:
        if schema.fill_mode == "overlay":
            pdf_bytes = overlay_fill(pdf_path, schema.boxes, by_id)
        else:
            named = {field.pdf_field_name: by_id[field.id] for field in schema.fields}
            pdf_bytes = fill_pdf(pdf_path, named)
    except (PdfFillError, OverlayFillError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="{schema.form_id}_filled.pdf"'
        },
    )


# The oldest extension build this server will answer a mapping request from.
#
# The kill switch for the one thing redacting in the browser cannot fix: an
# extension is updated by Chrome on Chrome's schedule, and a Web Store review
# takes days. If a redaction bug ships, there is no way to push a fix in
# minutes the way a server redeploy can — but there IS a way to stop the old
# build from sending anything, and this is it. Raise it, and every panel older
# than the number refuses to map before it redacts, rather than redacting
# badly.
#
# Raise it ONLY for a fault that makes the old build unsafe. It stops doctors
# working, which is the correct response to "that version puts names on the
# wire" and a wildly disproportionate one to a UI bug.
MIN_EXTENSION_VERSION = "0.3.0"


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "forms_loaded": len(FORM_SCHEMAS),
        "min_extension_version": MIN_EXTENSION_VERSION,
    }


# ---------------------------------------------------------------------------
# The extension itself
# ---------------------------------------------------------------------------
#
# Zipped from the source tree on request rather than built into a static file,
# so what a doctor downloads is always the code this server is running against
# — a stale .crx that expects an endpoint the backend no longer has is a
# support problem nobody would think to check for.
#
# Not signed and not a .crx: without a Chrome Web Store listing the install is
# "unzip, then load unpacked", and the landing page says so rather than
# implying a one-click install that does not exist.

EXTENSION_DIR = REPO_ROOT / "extension"
EXTENSION_ZIP_NAME = "breezefill-extension.zip"

# Tests and editor droppings are not part of an install. `node_modules` is
# excluded defensively: it is not supposed to exist under extension/, and a
# recursive walk that quietly picked one up would produce a huge download.
_NOT_SHIPPED = ("*.test.js", "*.map", ".DS_Store")
_NOT_SHIPPED_DIRS = {"node_modules", "__pycache__", ".git"}


def _ships_in_the_extension(path: Path) -> bool:
    if any(part in _NOT_SHIPPED_DIRS for part in path.parts):
        return False
    return not any(path.match(pattern) for pattern in _NOT_SHIPPED)


@app.get(f"/download/{EXTENSION_ZIP_NAME}")
def download_extension() -> Response:
    """The unpacked extension, as a zip the doctor loads into Chrome."""
    if not EXTENSION_DIR.is_dir():
        raise HTTPException(status_code=404, detail="extension not bundled in this build")

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(EXTENSION_DIR.rglob("*")):
            if not path.is_file() or not _ships_in_the_extension(path):
                continue
            # Everything lands under one folder, so unzipping produces exactly
            # the directory Chrome's "Load unpacked" wants selected.
            archive.write(path, Path("breezefill-extension") / path.relative_to(EXTENSION_DIR))

    return Response(
        content=buffer.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{EXTENSION_ZIP_NAME}"'},
    )


# ---------------------------------------------------------------------------
# Static frontend
# ---------------------------------------------------------------------------
#
# In production the React build is served from this same app, so the doctor
# visits one URL and there is no cross-origin call to configure. Mounted LAST
# so every API route above wins; the catch-all only sees what they didn't
# match. Absent in local dev (Vite serves the frontend on :5173 instead).

if FRONTEND_DIR.is_dir():
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
