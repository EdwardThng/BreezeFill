"""LLM mapping call: form schema + redacted clinical text -> validated field
answers (README section 5).

Rules enforced here:
- The LLM only ever sees redacted text. Callers must pass text that has been
  through redaction.redact() — this module never touches PatientRecord
  demographics except for deterministic direct-copy fields.
- Every LLM answer carries a status (extracted/inferred/missing) and a source
  snippet. No silent guesses: anything the model omits or malforms becomes
  status="missing".
- Re-merged values containing an unresolvable [TOKEN] are flagged for manual
  review — never allowed through to a PDF.
- No patient data in logs or exceptions.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel

from redaction import PatientRecord, remerge

# Top-tier model first, optimize cost later (spec 5). The sweep is the cheap
# safety-net call (spec 3.3 pass 3). Both overridable via env for the
# SG-region switch before real patient data.
MAPPING_MODEL = os.environ.get("FORMFILL_MAPPING_MODEL", "claude-opus-4-8")
SWEEP_MODEL = os.environ.get("FORMFILL_SWEEP_MODEL", "claude-haiku-4-5")

SYSTEM_PROMPT = """\
You fill medical insurance forms from clinical notes. You will receive a form \
schema and de-identified clinical notes in which identifiers appear as tokens \
like [PATIENT] or [NRIC]. Return a JSON object with a "fields" array holding \
exactly one entry per form field id. Each entry has:
- id: the form field id
- value: the answer as a string, formatted per the field type (text: plain \
string; date: DD/MM/YYYY; checkbox: "true" or "false")
- status: "extracted" (directly stated in the notes) | "inferred" (a \
reasonable clinical inference from the notes) | "missing" (not determinable)
- source: the verbatim snippet from the notes that supports the value, or \
an empty string when status is "missing"

Rules:
- Never invent clinical facts. If the notes are ambiguous, prefer "missing" \
over guessing.
- Dates must be DD/MM/YYYY.
- Use [TOKENS] exactly as they appear if a token belongs in a field.
- For status "missing", set value to an empty string.
"""


class MappingError(Exception):
    """LLM call failed or returned unusable output. Message must never
    contain clinical text or patient data."""


class FormField(BaseModel):
    id: str
    pdf_field_name: str
    type: Literal["text", "date", "checkbox"]
    source: str  # "llm" or "demographics.<attr>"
    description: str | None = None


class FormSchema(BaseModel):
    form_id: str
    pdf_path: str
    fields: list[FormField]

    @property
    def llm_fields(self) -> list[FormField]:
        return [f for f in self.fields if f.source == "llm"]


class FieldAnswer(BaseModel):
    value: str | bool | None
    status: Literal["extracted", "inferred", "missing"]
    source: str | None = None


class MappedField(BaseModel):
    """One row in the review UI: the re-merged value plus everything the
    doctor needs to accept or correct it."""

    field_id: str
    pdf_field_name: str
    field_type: Literal["text", "date", "checkbox"]
    value: str | bool | None
    # "demographic" = deterministic copy, pre-approved green in the UI
    status: Literal["extracted", "inferred", "missing", "demographic"]
    source: str | None
    # Guardrail 3: anything not directly extracted (or containing an
    # unresolved token) requires an explicit click to accept.
    needs_review: bool


def load_form_schema(path: str | Path) -> FormSchema:
    return FormSchema.model_validate_json(Path(path).read_text(encoding="utf-8"))


# ---------------------------------------------------------------------------
# Structured-output schema, built per form
# ---------------------------------------------------------------------------

def build_output_schema(fields: list[FormField]) -> dict[str, Any]:
    # One shared array-item definition with the field ids as an enum, instead
    # of a per-field object property. The structured-output API compiles the
    # schema to a grammar with hard size limits (no more than 16 union-typed
    # parameters, bounded total grammar size) — a real insurer form has 20+
    # fields and blows both limits under the per-field-object shape. Values
    # are always strings ("true"/"false" for checkboxes, "" for no answer)
    # and get coerced back to their real types on parse.
    return {
        "type": "object",
        "properties": {
            "fields": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "id": {"type": "string", "enum": [f.id for f in fields]},
                        "value": {"type": "string"},
                        "status": {
                            "type": "string",
                            "enum": ["extracted", "inferred", "missing"],
                        },
                        "source": {"type": "string"},
                    },
                    "required": ["id", "value", "status", "source"],
                    "additionalProperties": False,
                },
            }
        },
        "required": ["fields"],
        "additionalProperties": False,
    }


def _build_user_prompt(schema: FormSchema, redacted_text: str) -> str:
    field_lines = [
        {"id": f.id, "type": f.type, "description": f.description or ""}
        for f in schema.llm_fields
    ]
    return (
        "Form fields to fill:\n"
        f"{json.dumps(field_lines, indent=2)}\n\n"
        "De-identified clinical notes:\n"
        f"<notes>\n{redacted_text}\n</notes>"
    )


# ---------------------------------------------------------------------------
# LLM calls
# ---------------------------------------------------------------------------


def _default_client():
    import anthropic

    return anthropic.Anthropic()


def map_fields(
    schema: FormSchema,
    redacted_text: str,
    client=None,
    model: str = MAPPING_MODEL,
) -> dict[str, FieldAnswer]:
    """One structured-output call per form. Returns an answer for every
    source=llm field; anything the model omitted or malformed comes back as
    status="missing" rather than being silently dropped."""
    client = client or _default_client()
    llm_fields = schema.llm_fields
    if not llm_fields:
        return {}

    response = client.messages.create(
        model=model,
        max_tokens=16000,
        thinking={"type": "adaptive"},
        system=SYSTEM_PROMPT,
        output_config={"format": {"type": "json_schema", "schema": build_output_schema(llm_fields)}},
        messages=[{"role": "user", "content": _build_user_prompt(schema, redacted_text)}],
    )

    if response.stop_reason == "refusal":
        raise MappingError("mapping call was refused by the model")
    if response.stop_reason == "max_tokens":
        raise MappingError("mapping call hit max_tokens; output incomplete")

    text = next((b.text for b in response.content if b.type == "text"), None)
    if text is None:
        raise MappingError("mapping call returned no text block")
    try:
        raw = json.loads(text)
    except json.JSONDecodeError as exc:
        raise MappingError("mapping call returned invalid JSON") from exc

    items = raw.get("fields") if isinstance(raw, dict) else None
    by_id: dict[str, Any] = {}
    if isinstance(items, list):
        for item in items:
            if isinstance(item, dict) and isinstance(item.get("id"), str):
                by_id.setdefault(item["id"], item)

    return {field.id: _coerce_answer(field, by_id.get(field.id)) for field in llm_fields}


def _coerce_answer(field: FormField, item: Any) -> FieldAnswer:
    """One parsed array entry -> FieldAnswer. Anything malformed, empty, or
    marked missing collapses to a clean status="missing" answer — never a
    crash, never a silent guess."""
    missing = FieldAnswer(value=None, status="missing", source=None)
    if not isinstance(item, dict):
        return missing
    status = item.get("status")
    value = item.get("value")
    if status not in ("extracted", "inferred") or not isinstance(value, str) or value == "":
        return missing
    parsed: str | bool = value
    if field.type == "checkbox":
        flag = value.strip().lower()
        if flag not in ("true", "false"):
            return missing
        parsed = flag == "true"
    source = item.get("source")
    return FieldAnswer(
        value=parsed,
        status=status,
        source=source if isinstance(source, str) and source else None,
    )


def llm_sweep(text: str, client=None, model: str = SWEEP_MODEL) -> list[str]:
    """Pass-3 redaction safety net (spec 3.3): ask a cheap model whether any
    identifiers survived passes 1-2. Only ever called with already-redacted
    text. Returns verbatim strings to tokenize, or [] when clean."""
    client = client or _default_client()
    response = client.messages.create(
        model=model,
        max_tokens=1024,
        messages=[
            {
                "role": "user",
                "content": (
                    "Does the following text contain any person names, ID "
                    "numbers, phone numbers, email addresses, or street "
                    "addresses that are NOT already replaced by [TOKENS]? "
                    "List each one verbatim on its own line, or reply NONE.\n\n"
                    f"<text>\n{text}\n</text>"
                ),
            }
        ],
    )
    reply = next((b.text for b in response.content if b.type == "text"), "").strip()
    if not reply or reply.upper() == "NONE":
        return []
    lines = [line.strip().lstrip("-• ").strip() for line in reply.splitlines()]
    return [line for line in lines if line and line.upper() != "NONE"]


# ---------------------------------------------------------------------------
# Claim assembly: demographics direct-copy + re-merged LLM answers
# ---------------------------------------------------------------------------


def _demographic_value(record: PatientRecord, attr: str) -> str | None:
    if attr == "dob":
        return f"{record.dob.day:02d}/{record.dob.month:02d}/{record.dob.year}"
    value = getattr(record, attr, None)
    return value if value is None or isinstance(value, str) else str(value)


def assemble_claim(
    schema: FormSchema,
    record: PatientRecord,
    answers: dict[str, FieldAnswer],
    redaction_map: dict[str, str],
) -> list[MappedField]:
    """Merge deterministic demographics with re-merged LLM answers into the
    row list the review UI renders. LLM values have tokens substituted back;
    any unresolved token forces needs_review with the value blanked."""
    rows: list[MappedField] = []
    for field in schema.fields:
        if field.source.startswith("demographics."):
            attr = field.source.removeprefix("demographics.")
            rows.append(
                MappedField(
                    field_id=field.id,
                    pdf_field_name=field.pdf_field_name,
                    field_type=field.type,
                    value=_demographic_value(record, attr),
                    status="demographic",
                    source=None,
                    needs_review=False,
                )
            )
            continue

        answer = answers.get(field.id) or FieldAnswer(value=None, status="missing", source=None)
        value = answer.value
        status = answer.status
        needs_review = status != "extracted"
        if isinstance(value, str):
            merged, unresolved = remerge(value, redaction_map)
            if unresolved:
                # Never let a raw token near the PDF; make the doctor fill it.
                value, status, needs_review = None, "missing", True
            else:
                value = merged
        rows.append(
            MappedField(
                field_id=field.id,
                pdf_field_name=field.pdf_field_name,
                field_type=field.type,
                value=value,
                status=status,
                source=answer.source,
                needs_review=needs_review,
            )
        )
    return rows
