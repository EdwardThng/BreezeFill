"""PDF fill layer (README section 7): write approved values into AcroForm
fields with pypdf.

- NeedAppearances is set so values render in Adobe/Preview/Chrome.
- Checkboxes are set to the field's own export value (dumped from the PDF,
  not assumed to be /Yes).
- Defense in depth: any value still containing a redaction [TOKEN] is
  rejected here even if upstream checks missed it — a raw token must never
  reach a filled PDF.

Also exposes dump_pdf_fields() / `python pdf_fill.py <pdf>` for Day-3 schema
authoring: dump a form's field names, types, and checkbox export values.
"""

from __future__ import annotations

import io
from pathlib import Path
from typing import Any

from pypdf import PdfReader, PdfWriter

from redaction import TOKEN_RE


class PdfFillError(Exception):
    """Schema/PDF mismatch or unsafe value. Never include clinical text or
    patient data in the message — field names only."""


def dump_pdf_fields(pdf_path: str | Path) -> list[dict[str, Any]]:
    """List a fillable PDF's AcroForm fields. Use this when writing the JSON
    schema for a new insurer form."""
    reader = PdfReader(str(pdf_path))
    fields = reader.get_fields() or {}
    return [
        {
            "name": name,
            "type": field.get("/FT"),
            "states": field.get("/_States_"),
            "current_value": field.get("/V"),
        }
        for name, field in fields.items()
    ]


def _checkbox_on_state(field: dict[str, Any], name: str) -> str:
    states = field.get("/_States_") or []
    on_states = [s for s in states if s != "/Off"]
    if not on_states:
        raise PdfFillError(f"checkbox {name!r} has no on-state export value")
    return on_states[0]


def fill_pdf(pdf_path: str | Path, values: dict[str, str | bool | None]) -> bytes:
    """Fill AcroForm fields by PDF field name and return the filled PDF bytes.

    values: {pdf_field_name: value}. None leaves the field blank. Booleans
    are only valid for checkbox fields; strings only for text fields.
    """
    pdf_path = Path(pdf_path)
    if not pdf_path.exists():
        raise PdfFillError(f"form PDF not found: {pdf_path.name}")

    reader = PdfReader(str(pdf_path))
    pdf_fields = reader.get_fields() or {}
    if not pdf_fields:
        raise PdfFillError(f"{pdf_path.name} has no AcroForm fields")

    unknown = sorted(set(values) - set(pdf_fields))
    if unknown:
        # Loud failure: the JSON schema is out of sync with the PDF.
        raise PdfFillError(f"schema/PDF mismatch, unknown fields: {unknown}")

    updates: dict[str, str] = {}
    for name, value in values.items():
        if value is None:
            continue
        if isinstance(value, str) and TOKEN_RE.search(value):
            raise PdfFillError(f"unresolved redaction token in field {name!r}")
        field = pdf_fields[name]
        is_checkbox = field.get("/FT") == "/Btn"
        if is_checkbox:
            if not isinstance(value, bool):
                raise PdfFillError(f"field {name!r} is a checkbox; expected a boolean")
            updates[name] = _checkbox_on_state(field, name) if value else "/Off"
        else:
            if isinstance(value, bool):
                raise PdfFillError(f"field {name!r} is not a checkbox; got a boolean")
            updates[name] = value

    writer = PdfWriter(clone_from=str(pdf_path))
    writer.set_need_appearances_writer(True)
    for page in writer.pages:
        if page.get("/Annots"):
            writer.update_page_form_field_values(page, updates, auto_regenerate=False)

    buffer = io.BytesIO()
    writer.write(buffer)
    return buffer.getvalue()


if __name__ == "__main__":
    import json
    import sys

    print(json.dumps(dump_pdf_fields(sys.argv[1]), indent=2, default=str))
