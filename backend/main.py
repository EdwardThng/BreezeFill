"""FastAPI app (README section 8): POST /claims, POST /claims/{id}/approve.

Data-retention rules enforced here (guardrails, section 10):
- Claims live in an in-memory store only. Nothing patient-related touches
  disk except the filled PDF streamed back to the client.
- The raw clinical_text and redaction map are dropped as soon as the claim
  rows are assembled — after create, the server holds only the review rows.
- Approve returns the filled PDF and deletes the claim. Stale claims are
  purged after CLAIM_TTL.
- No patient data in logs or error messages.
"""

from __future__ import annotations

import logging
import os
import threading
import time
import uuid
from pathlib import Path

import anthropic
from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from mapping import (
    FormSchema,
    MappingError,
    assemble_claim,
    llm_sweep,
    load_form_schema,
    map_fields,
    MappedField,
)
from overlay_fill import OverlayFillError, overlay_fill
from pdf_fill import PdfFillError, fill_pdf
from redaction import PatientRecord, redact

REPO_ROOT = Path(__file__).resolve().parent.parent
SCHEMAS_DIR = Path(__file__).resolve().parent / "schemas"
FRONTEND_DIR = REPO_ROOT / "frontend" / "dist"
CLAIM_TTL_SECONDS = 60 * 60  # zero long-term retention; 1h working window

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
# In-memory claim store (patient data never persisted)
# ---------------------------------------------------------------------------


class ClaimSession(BaseModel):
    claim_id: str
    form_id: str
    rows: list[MappedField]
    created_at: float


_claims: dict[str, ClaimSession] = {}
_claims_lock = threading.Lock()


def _purge_stale_claims() -> None:
    cutoff = time.time() - CLAIM_TTL_SECONDS
    with _claims_lock:
        for claim_id in [c for c, s in _claims.items() if s.created_at < cutoff]:
            del _claims[claim_id]


# ---------------------------------------------------------------------------
# Request/response models
# ---------------------------------------------------------------------------


class CreateClaimRequest(BaseModel):
    form_id: str
    patient: PatientRecord


class ClaimResponse(BaseModel):
    claim_id: str
    form_id: str
    fields: list[MappedField]


class MapResponse(BaseModel):
    """Same review rows as ClaimResponse, minus the claim id — because there
    is no claim to refer back to."""

    form_id: str
    fields: list[MappedField]


class ApproveClaimRequest(BaseModel):
    # Doctor-edited final values keyed by field_id. Fields omitted here keep
    # the value from the review rows; explicit null blanks the field.
    values: dict[str, str | bool | None] = {}


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@app.get("/forms")
def list_forms() -> list[dict]:
    """Forms offered in the picker — internal fixtures are excluded."""
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
                }
                for f in s.fields
            ],
        }
        for s in FORM_SCHEMAS.values()
        if not s.internal
    ]


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


@app.post("/claims", response_model=ClaimResponse)
def create_claim(request: CreateClaimRequest) -> ClaimResponse:
    _purge_stale_claims()
    schema = _get_schema(request.form_id)
    rows = _review_rows(schema, request.patient)
    # From here on, only the review rows are retained — the raw record,
    # redacted text, and redaction map go out of scope now.
    claim = ClaimSession(
        claim_id=uuid.uuid4().hex,
        form_id=schema.form_id,
        rows=rows,
        created_at=time.time(),
    )
    with _claims_lock:
        _claims[claim.claim_id] = claim
    return ClaimResponse(claim_id=claim.claim_id, form_id=claim.form_id, fields=rows)


def _get_claim(claim_id: str) -> ClaimSession:
    with _claims_lock:
        claim = _claims.get(claim_id)
    if claim is None:
        raise HTTPException(status_code=404, detail="claim not found or already completed")
    return claim


@app.get("/claims/{claim_id}", response_model=ClaimResponse)
def get_claim(claim_id: str) -> ClaimResponse:
    claim = _get_claim(claim_id)
    return ClaimResponse(claim_id=claim.claim_id, form_id=claim.form_id, fields=claim.rows)


@app.post("/claims/{claim_id}/approve")
def approve_claim(claim_id: str, request: ApproveClaimRequest) -> Response:
    claim = _get_claim(claim_id)
    schema = _get_schema(claim.form_id)

    # Overlay forms address fields by id (the schema carries the box);
    # AcroForm forms address them by the PDF's own field name.
    by_id: dict[str, str | bool | None] = {}
    for row in claim.rows:
        by_id[row.field_id] = (
            request.values[row.field_id] if row.field_id in request.values else row.value
        )
    unknown = sorted(set(request.values) - set(by_id))
    if unknown:
        raise HTTPException(status_code=422, detail=f"unknown field ids: {unknown}")

    pdf_path = (REPO_ROOT / schema.pdf_path).resolve()
    try:
        if schema.fill_mode == "overlay":
            pdf_bytes = overlay_fill(pdf_path, schema.boxes, by_id)
        else:
            named = {row.pdf_field_name: by_id[row.field_id] for row in claim.rows}
            pdf_bytes = fill_pdf(pdf_path, named)
    except (PdfFillError, OverlayFillError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    # Success: the claim is done — delete server-side state (guardrail:
    # process -> download -> delete).
    with _claims_lock:
        _claims.pop(claim_id, None)

    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="{schema.form_id}_filled.pdf"'
        },
    )


@app.delete("/claims/{claim_id}", status_code=204)
def discard_claim(claim_id: str) -> Response:
    with _claims_lock:
        _claims.pop(claim_id, None)
    return Response(status_code=204)


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "forms_loaded": len(FORM_SCHEMAS)}


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
