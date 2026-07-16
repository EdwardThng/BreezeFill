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

import os
import threading
import time
import uuid
from pathlib import Path

import anthropic
from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
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
from pdf_fill import PdfFillError, fill_pdf
from redaction import PatientRecord, redact

REPO_ROOT = Path(__file__).resolve().parent.parent
SCHEMAS_DIR = Path(__file__).resolve().parent / "schemas"
CLAIM_TTL_SECONDS = 60 * 60  # zero long-term retention; 1h working window

app = FastAPI(title="FormFill", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
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


class ApproveClaimRequest(BaseModel):
    # Doctor-edited final values keyed by field_id. Fields omitted here keep
    # the value from the review rows; explicit null blanks the field.
    values: dict[str, str | bool | None] = {}


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@app.get("/forms")
def list_forms() -> list[dict]:
    return [
        {
            "form_id": s.form_id,
            "fields": [
                {"id": f.id, "type": f.type, "source": f.source, "description": f.description}
                for f in s.fields
            ],
        }
        for s in FORM_SCHEMAS.values()
    ]


@app.post("/claims", response_model=ClaimResponse)
def create_claim(request: CreateClaimRequest) -> ClaimResponse:
    _purge_stale_claims()
    schema = _get_schema(request.form_id)

    sweep = None if os.environ.get("FORMFILL_DISABLE_SWEEP") else llm_sweep
    try:
        result = redact(request.patient, llm_sweep=sweep)
        answers = map_fields(schema, result.redacted_text)
    except MappingError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except (anthropic.APIError, anthropic.APIConnectionError) as exc:
        # Generic detail on purpose: no clinical text in errors or logs.
        raise HTTPException(status_code=502, detail="LLM call failed") from exc

    rows = assemble_claim(schema, request.patient, answers, result.redaction_map)
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

    values: dict[str, str | bool | None] = {}
    known_ids = set()
    for row in claim.rows:
        known_ids.add(row.field_id)
        final = request.values[row.field_id] if row.field_id in request.values else row.value
        values[row.pdf_field_name] = final
    unknown = sorted(set(request.values) - known_ids)
    if unknown:
        raise HTTPException(status_code=422, detail=f"unknown field ids: {unknown}")

    pdf_path = (REPO_ROOT / schema.pdf_path).resolve()
    try:
        pdf_bytes = fill_pdf(pdf_path, values)
    except PdfFillError as exc:
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
