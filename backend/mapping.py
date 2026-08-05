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
import re
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, model_validator

from overlay_fill import FieldBox
from redaction import PatientRecord, remerge

# Top-tier model on both calls: the sweep is the last line of defence against
# an identifier reaching the LLM-facing text, so it is worth Opus rates.
# Overridable via env — drop the sweep to a cheaper model if cost bites.
MAPPING_MODEL = os.environ.get("FORMFILL_MAPPING_MODEL", "claude-opus-5")
SWEEP_MODEL = os.environ.get("FORMFILL_SWEEP_MODEL", "claude-opus-5")

# Where inference runs. The API accepts only "us" and "global" today —
# there is no Singapore value, so in-region SG inference is NOT reachable
# from the first-party API and would need Bedrock ap-southeast-1 instead.
# Unset means the workspace default (global routing). "us" costs 1.1x.
# Requires a 4.6+ model: older models 400 on this parameter.
INFERENCE_GEO = os.environ.get("FORMFILL_INFERENCE_GEO") or None


def _geo_kwargs() -> dict[str, str]:
    return {"inference_geo": INFERENCE_GEO} if INFERENCE_GEO else {}

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

The costs here are not symmetric. A field you leave blank costs the doctor a \
few seconds to write in by hand. A field you fill wrongly can be signed and \
submitted to an insurer as the doctor's own clinical statement. Leaving a \
field blank is always the safe choice; filling one is a claim you are making \
on the doctor's behalf. Prefer fewer, correct answers over complete coverage.

Rules:
- Never invent clinical facts. Answer only from what the notes actually say.
- When in doubt, return "missing". Ambiguity, a plausible-but-unstated \
detail, or a value you would have to reason towards are all "missing".
- Use "extracted" only when the notes state the answer directly, and quote \
that statement verbatim in source.
- Use "inferred" sparingly: only where a clinician reading these notes would \
reach the same conclusion without hesitation (for example an ICD code for an \
explicitly named diagnosis). If two reasonable clinicians might answer \
differently, it is "missing".
- Do not stretch a value to fit a field. If the notes answer a neighbouring \
question but not this one, this field is "missing".
- Dates are DD/MM/YYYY unless the field's own description states a different \
format. The field wins: its format is the shape of the box on the printed \
form, so a field asking for DD/MM/YY wants exactly two year digits. Never \
assume a year that is not in the notes.
- Use [TOKENS] exactly as they appear if a token belongs in a field.
- For status "missing", set value to an empty string.
- When a field lists "options", the answer must be one of them, copied \
character for character. Do not paraphrase, reorder or abbreviate an option, \
and do not answer with wording the form does not offer. If none of the options \
is right, the field is "missing" — a near-miss is rejected, not rounded to the \
closest one.
"""


class MappingError(Exception):
    """LLM call failed or returned unusable output. Message must never
    contain clinical text or patient data."""


class FormField(BaseModel):
    id: str
    # AcroForm forms address fields by name; overlay forms address them by
    # box, so exactly one of these is set (enforced on FormSchema below).
    pdf_field_name: str = ""
    box: FieldBox | None = None
    type: Literal["text", "date", "checkbox"]
    source: str  # "llm" or "demographics.<attr>"
    description: str | None = None
    # Human wording for the review screen. Falls back to a prettified id so a
    # half-written schema still renders something readable.
    label: str | None = None
    # The answers this field actually accepts, verbatim as the form words them
    # ("B1 (4-bedded)", not "Ward B1"). Empty means free text.
    #
    # Declaring them does two things, and the second is the one that matters.
    # The model is shown the list, so it chooses wording instead of guessing at
    # it. And an answer that is not on the list is downgraded to "missing"
    # rather than carried forward — see _coerce_answer. Without that, a
    # near-miss survives all the way to the browser, where applySelect finds no
    # matching option and skips the field silently: the doctor reviewed a value,
    # approved it, and nothing was written.
    #
    # Validated after parsing rather than constrained in the output grammar.
    # A per-field enum would mean per-field properties, which is the shape that
    # blows the structured-output grammar limits on a real 24-field form (see
    # build_output_schema). This gets the same guarantee with no grammar risk.
    options: list[str] = []
    # Which step of a multi-step form this field appears on. Empty for a form
    # that shows everything at once.
    #
    # A wizard renders one step at a time, so a plan spanning two of them finds
    # about half its fields in the DOM on either — under MIN_MATCH_RATE, so the
    # filler writes nothing and the guard systematically answers "wrong page"
    # about the right page. Grouping by this lets the guard be evaluated per
    # step, which is the fix that does not involve loosening it.
    #
    # The value is free text and only ever compared for equality, so it can be
    # whatever `<legend>` the learn-mode dumper recorded for that step.
    step: str | None = None

    @property
    def display_label(self) -> str:
        if self.label:
            return self.label
        words = self.id.replace("_", " ")
        return words[:1].upper() + words[1:]


class FormSchema(BaseModel):
    form_id: str
    # Empty for fill_mode="web": there is no PDF to write into.
    pdf_path: str = ""
    fields: list[FormField]
    # "acroform" writes into the PDF's own fields; "overlay" stamps text at
    # coordinates, for insurers who publish no fillable version; "web" is
    # filled in place in the browser by the extension, for insurers who send a
    # link instead of a form. A web schema is the same rows and the same
    # review — only the target differs, which is why it is a mode here rather
    # than a second kind of object.
    fill_mode: Literal["acroform", "overlay", "web"] = "acroform"
    # Shown in the form picker instead of the raw form_id.
    display_name: str | None = None
    insurer: str | None = None
    # Hosts this form is served from, for the browser extension: the doctor is
    # already standing on the insurer's page, so asking them which insurer form
    # they are looking at is a question the page can answer itself. Matched on
    # the host alone — never the path or query, because a ClaimEZ URL's `?pid=`
    # is a bearer credential for one patient's claim.
    hosts: list[str] = []
    # Test/dev fixtures stay usable by form_id but are kept out of the picker,
    # so a doctor is never offered a form that isn't a real insurer's.
    internal: bool = False

    @property
    def llm_fields(self) -> list[FormField]:
        return [f for f in self.fields if f.source == "llm"]

    @property
    def boxes(self) -> dict[str, FieldBox]:
        return {f.id: f.box for f in self.fields if f.box is not None}

    @model_validator(mode="after")
    def _check_addressing(self) -> FormSchema:
        """Catch a half-written schema at load time rather than at the moment
        a doctor clicks Approve."""
        # A web form is located at fill time by matching the schema's labels
        # against the live page, so there is nothing to address here — and
        # nothing to open either. Requiring a pdf_path would mean pointing a
        # web schema at some unrelated PDF, which is the kind of untrue field
        # that later gets believed.
        if self.fill_mode == "web":
            if self.pdf_path:
                raise ValueError("web form has a pdf_path; it has no PDF to fill")
            return self

        if not self.pdf_path:
            raise ValueError(f"{self.fill_mode} form has no pdf_path")
        for field in self.fields:
            if self.fill_mode == "overlay" and field.box is None:
                raise ValueError(f"overlay field {field.id!r} has no box")
            if self.fill_mode == "acroform" and not field.pdf_field_name:
                raise ValueError(f"acroform field {field.id!r} has no pdf_field_name")
        return self


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
    # What the doctor reads: a plain label plus the question the form asks.
    label: str
    help: str | None
    value: str | bool | None
    # "demographic" = deterministic copy, pre-approved green in the UI
    status: Literal["extracted", "inferred", "missing", "demographic"]
    source: str | None
    # Guardrail 3: anything not directly extracted (or containing an
    # unresolved token) requires an explicit click to accept.
    needs_review: bool
    # Why this row is held for the doctor when its status alone would not hold
    # it. Rendered in place of the status note, because a confirm box with
    # nothing to check becomes a box that gets clicked: "Copied from what you
    # wrote" above a Confirm button tells the doctor there is nothing to do.
    # None for every row whose status already explains itself.
    recheck: str | None = None
    # Copied from the schema so the review screen can offer the real choices
    # instead of a free-text box, and so a doctor correcting a value picks
    # something the control will accept rather than retyping the near-miss the
    # model was just refused for.
    options: list[str] = []
    # Which wizard step this field lives on. The panel groups the fill plan by
    # it so the match guard is evaluated against the step on screen rather than
    # against a whole form that is never in the DOM at once.
    step: str | None = None


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
    field_lines = []
    for f in schema.llm_fields:
        line: dict[str, Any] = {
            "id": f.id,
            "type": f.type,
            "description": f.description or "",
        }
        # Only when the field has them: an empty "options": [] reads as "this
        # field accepts nothing" to a model skimming a 24-entry list.
        if f.options:
            line["options"] = f.options
        field_lines.append(line)
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
        **_geo_kwargs(),
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


def _match_option(value: str, options: list[str]) -> str | None:
    """An answer mapped onto one of the field's declared options, or None.

    Case and surrounding whitespace are forgiven because they carry no meaning
    on a dropdown; nothing else is. In particular this does NOT try to find the
    closest option — "Ward B1" against "B1 (4-bedded)" returns None, and the
    field ends up missing.

    That is the whole point rather than a limitation to fix later. The options
    come off the form itself, so an answer that does not appear in them is one
    the model composed. Snapping it to whichever option looks nearest is a
    guess at what the doctor is about to sign, made by string distance, and it
    would be indistinguishable in review from an answer the notes supported.
    """
    wanted = " ".join(value.split()).casefold()
    for option in options:
        if " ".join(option.split()).casefold() == wanted:
            # The form's own wording, not the model's rendering of it. What
            # gets written must be a string the control actually offers, and
            # applySelect matches option text exactly.
            return option
    return None


# A description asking for a two-digit year: "DD/MM/YY" but not "DD/MM/YYYY".
_WANTS_SHORT_YEAR = re.compile(r"DD/MM/YY(?!Y)", re.IGNORECASE)
_FULL_DATE = re.compile(r"^(\d{2}/\d{2}/)(\d{2})(\d{2})$")


def _apply_date_format(field: FormField, value: str) -> str:
    """A date answer rendered in the format the field's own boxes expect.

    The prompt asks for this, and asking is not enough: on the one form that
    wants DD/MM/YY, a real run produced two fields in DD/MM/YY and two in
    DD/MM/YYYY — the same date written two ways on one signed claim. So the
    format is enforced here rather than hoped for.

    Only the century is dropped, and only when the field asked for a short
    year. That direction is lossless: 14/03/2026 -> 14/03/26 is the same date.

    The reverse is NOT done. Expanding 14/03/26 would mean choosing a century
    for it, and a claim form carries dates of birth as readily as dates of
    admission — "26" is 2026 or 1926 depending on which box it sits in, and
    that is not a guess worth making silently on a document a doctor signs.
    A field wanting a full year that receives a short one keeps what the model
    returned, and the doctor sees it in review.
    """
    if not _WANTS_SHORT_YEAR.search(field.description or ""):
        return value
    match = _FULL_DATE.match(value.strip())
    return f"{match.group(1)}{match.group(3)}" if match else value


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
    elif field.options:
        # An off-list answer is treated exactly like a malformed one, which is
        # the same thing it is: the model was given the permitted set and
        # returned something outside it, so what it returned is not an answer
        # to this question.
        canonical = _match_option(value, field.options)
        if canonical is None:
            return missing
        parsed = canonical
    elif field.type == "date":
        parsed = _apply_date_format(field, value)
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
        **_geo_kwargs(),
    )
    reply = next((b.text for b in response.content if b.type == "text"), "").strip()
    if not reply or reply.upper() == "NONE":
        return []
    lines = [line.strip().lstrip("-• ").strip() for line in reply.splitlines()]
    return [line for line in lines if line and line.upper() != "NONE"]


# ---------------------------------------------------------------------------
# Claim assembly: demographics direct-copy + re-merged LLM answers
# ---------------------------------------------------------------------------


# Every date with a value goes back to the doctor to re-read, whatever status
# it carries. `extracted` means the notes stated it — not that they stated it
# unambiguously, and a bare DD/MM is not an unambiguous statement of anything.
#
# "03/07" is 3 July to a Singapore GP and 7 March to a CMS exporting US-format
# dates, and both readings render as a perfectly plausible date on a claim
# form. Nothing downstream can separate them: the note is the only evidence
# and the note is precisely what is ambiguous, so re-reading it harder does not
# help. `_apply_date_format` only reshapes what the model returned — it cannot
# know which of two dates was meant.
#
# This is therefore not a check the pipeline can do on the doctor's behalf, and
# it is the one place where the usual asymmetry inverts: a swapped date is not
# a blank the doctor notices and writes in, it is a *wrong answer that looks
# right*, signed and sent to the insurer as their own statement of when the
# patient was admitted.
DATE_RECHECK = (
    "Check the day and month are the right way round — a date written 03/07 "
    "is 3 July here and 7 March elsewhere."
)


def _date_recheck(field: FormField, value: str | bool | None) -> str | None:
    """The recheck reason for a row, or None.

    Only for dates that actually carry a value: a blank date is written by hand
    anyway and holding it would ask the doctor to confirm nothing. On the
    96-field AIA medical report that is the difference between confirming the
    two or three dates a note supported and confirming twenty-two.
    """
    if field.type != "date":
        return None
    if not isinstance(value, str) or not value.strip():
        return None
    return DATE_RECHECK


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
            value = _demographic_value(record, attr)
            # A demographic date is held too, and it is the one with the least
            # excuse for being trusted: it was not read by a model that could
            # be asked to reconsider, it was assigned by `parse_demographics`,
            # which resolves DD/MM by *rule* — Singapore writes day first — and
            # a note that did not is misread silently and identically every
            # time. The doctor sees it in the details drawer, but seeing a
            # pre-filled box is not the same as checking it, and a wrong date
            # of birth is what an insurer rejects the whole claim on.
            recheck = _date_recheck(field, value)
            rows.append(
                MappedField(
                    field_id=field.id,
                    pdf_field_name=field.pdf_field_name,
                    field_type=field.type,
                    label=field.display_label,
                    help=field.description,
                    value=value,
                    status="demographic",
                    source=None,
                    needs_review=recheck is not None,
                    recheck=recheck,
                    options=field.options,
                    # Demographics carry a step too: on a wizard they are
                    # usually the verification step, and a plan grouped by step
                    # has to account for them or that step looks empty.
                    step=field.step,
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
        # Never lowers the bar: a row already held stays held. The unresolved
        # token branch above blanked the value, so that row gets no recheck
        # reason and keeps the one its status gives it.
        recheck = _date_recheck(field, value)
        rows.append(
            MappedField(
                field_id=field.id,
                pdf_field_name=field.pdf_field_name,
                field_type=field.type,
                label=field.display_label,
                help=field.description,
                value=value,
                status=status,
                source=answer.source,
                needs_review=needs_review or recheck is not None,
                recheck=recheck,
                options=field.options,
                step=field.step,
            )
        )
    return rows
