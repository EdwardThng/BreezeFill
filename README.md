# FormFill MVP — Insurance Form Automation for SG Clinics

**Goal:** A working demo in ~2 weeks. One clinic, 3 forms, paste-in patient data, LLM maps clinical info to form fields, doctor reviews, PDF comes out filled. Nothing else.

**Success metric:** Dad fills a real insurance form for a real patient in under 3 minutes (baseline ~20 min), without you in the room.

---

## 1. What we are NOT building (yet)

- ❌ ClinicAssist integration (paste-in text blob is the MVP ingestion)
- ❌ Accounts, teams, billing, multi-clinic tenancy
- ❌ Storing patient data long-term (process → download → delete)
- ❌ Flat/scanned PDF support (start with fillable AcroForm PDFs only; if a target form is flat, do coordinate overlay for that one form manually)
- ❌ Fine-tuning, OCR pipelines, mobile app

---

## 2. Pipeline overview

```
[Paste patient record + demographics]
        │
        ▼
(A) Structured demographics  ──────────────┐  (never touches the LLM)
(B) Unstructured clinical text             │
        │                                  │
        ▼                                  │
  REDACTION MODULE                         │
  (strip identifiers → tokens)             │
        │                                  │
        ▼                                  │
  LLM MAPPING CALL                         │
  (form schema + redacted text → JSON      │
   {field_id: value, source, status})      │
        │                                  │
        ▼                                  │
  RE-MERGE (tokens → real values)  ◄───────┘
        │
        ▼
  REVIEW UI (doctor edits/approves, missing fields in red)
        │
        ▼
  PDF FILL → download → delete server-side data
```

Core principle: **LLM proposes, doctor decides.** Every LLM-filled field must carry a source snippet or a `missing` flag. No silent guesses.

---

## 3. Redaction module design

### 3.1 Why it exists

Identifiable patient data never leaves your Singapore infrastructure. The LLM only sees de-identified clinical text. Demographics are copied into the form deterministically — they never needed an LLM anyway.

### 3.2 Input contract

```python
class PatientRecord(BaseModel):
    # Structured — entered/pasted into labeled fields in the UI.
    # These are the redaction dictionary AND the demographic form values.
    full_name: str
    nric: str
    dob: date
    phone: str | None
    address: str | None
    policy_number: str | None
    insurer: str

    # Unstructured — the messy blob from ClinicAssist
    clinical_text: str
```

Forcing demographics into structured fields (rather than parsing them out of the blob) is deliberate: it gives you a **known-identifier dictionary** to redact against, and it removes any temptation to have the LLM extract identity data.

### 3.3 Redaction passes (in order)

Run over `clinical_text` only. Each match is replaced with a token and recorded in a mapping table.

**Pass 1 — Known identifiers (dictionary-based, highest confidence):**
- `full_name` → `[PATIENT]`. Match case-insensitively; also match each name part ≥ 3 chars individually (clinical notes say "Mr Tan" or "Wei Ming", not the full registered name). Handle common SG name orderings (surname-first).
- `nric` → `[NRIC]` (exact match).
- `phone`, `address`, `policy_number` → `[PHONE]`, `[ADDRESS]`, `[POLICY_NO]` (exact match).
- `dob` → `[DOB]`. Match multiple renderings: `14/03/1962`, `14 Mar 1962`, `1962-03-14`.

**Pass 2 — Pattern-based (catches identifiers NOT in the dictionary — family members, other patients mentioned in notes):**
- NRIC/FIN regex: `\b[STFGM]\d{7}[A-Z]\b` → `[NRIC_2]`, `[NRIC_3]`, ...
- SG phone: `\b[689]\d{3}[ -]?\d{4}\b` → `[PHONE_2]`, ...
- Email regex → `[EMAIL_1]`, ...

**Pass 3 — LLM sanity sweep (cheap model, redacted text only):**
One call to a small/cheap model: *"Does this text contain any person names, ID numbers, phone numbers, or addresses that are not already replaced by [TOKENS]? List them verbatim, or reply NONE."* Anything it finds gets tokenized too. This is your safety net for names you didn't know about (e.g., "seen previously by Dr Lim", "his wife Mdm Chua"). Cost: fractions of a cent; catches the long tail regex can't.

**Deliberately NOT redacted:** clinical dates (consultation dates, symptom onset), diagnoses, medications, doctor's own clinical observations. The form needs these and they are what the LLM must map. DOB is redacted because it's a direct identifier; visit dates are not.

### 3.4 Mapping table & re-merge

```python
redaction_map: dict[str, str]  # {"[PATIENT]": "Tan Wei Ming", "[NRIC]": "S1234567A", ...}
```

- Lives **in memory / server-side only** for the duration of the request session. Never sent to the LLM. Never logged.
- Re-merge = simple string substitution on the LLM's output values before rendering the review UI. If the LLM output contains a token you can't resolve, flag the field for manual review — never leave a raw `[TOKEN]` in a filled PDF.

### 3.5 Tests to write first (this module must be bulletproof)

- Golden set of ~10 synthetic clinical notes (write them yourself in your dad's note style) with known identifiers → assert zero identifiers survive redaction.
- Round-trip test: redact → re-merge → output equals input.
- Adversarial cases: name split across lines, lowercase name, NRIC with spaces, name that is also a common word (e.g., a patient surnamed "He" or "Ang") — for these, require word-boundary matching and accept some over-redaction; over-redaction is safe, under-redaction is not.

---

## 4. Form schema layer

One JSON file per insurer form, written by hand for the 3 MVP forms (~1–2 hrs each):

```json
{
  "form_id": "greateastern_specialist_report_v2024",
  "pdf_path": "forms/ge_specialist_report.pdf",
  "fields": [
    {
      "id": "diagnosis_primary",
      "pdf_field_name": "Text_Diagnosis1",
      "type": "text",
      "source": "llm",
      "description": "Primary diagnosis for this claim, with ICD code if available"
    },
    {
      "id": "date_first_consult",
      "pdf_field_name": "Date_FirstConsult",
      "type": "date",
      "source": "llm",
      "description": "Date the patient FIRST consulted this doctor for this condition (not the latest visit)"
    },
    {
      "id": "patient_name",
      "pdf_field_name": "Text_PatientName",
      "type": "text",
      "source": "demographics.full_name"
    },
    {
      "id": "symptoms_preexisting",
      "pdf_field_name": "Check_PreExisting",
      "type": "checkbox",
      "source": "llm",
      "description": "Did symptoms exist before the policy inception / is this a pre-existing condition per the notes?"
    }
  ]
}
```

- `source: "demographics.*"` fields are filled by direct copy — the LLM never sees them.
- `source: "llm"` fields go into the mapping prompt.
- Use `pypdf` to dump AcroForm field names from each PDF (`reader.get_fields()`), then write descriptions by hand. **The `description` strings are your real prompt engineering surface** — write them the way you'd brief a locum doctor.

---

## 5. LLM mapping call

One call per form. Structured output (JSON mode / tool use).

**System prompt sketch:**

> You fill medical insurance forms from clinical notes. You will receive a form schema and de-identified clinical notes (identifiers appear as tokens like [PATIENT]). For each field, return:
> - `value`: the answer, formatted per the field type
> - `status`: `"extracted"` (directly stated in notes) | `"inferred"` (reasonable clinical inference — explain) | `"missing"` (not determinable)
> - `source`: the verbatim snippet from the notes that supports the value, or null
>
> Rules: Never invent clinical facts. If notes are ambiguous, prefer `missing` over guessing. Dates must be DD/MM/YYYY. Use [TOKENS] as-is if a token belongs in a field.

**Output shape:**

```json
{
  "diagnosis_primary": {"value": "Acute appendicitis", "status": "extracted", "source": "Dx: acute appendicitis, confirmed on CT"},
  "date_first_consult": {"value": "02/06/2026", "status": "extracted", "source": "First seen 2/6/26 c/o RIF pain"},
  "symptoms_preexisting": {"value": false, "status": "inferred", "source": "acute onset 2 days prior"}
}
```

Model: use a top-tier model first (Claude Sonnet-class); optimize cost later. **Inference must run in-region (SG)** — Bedrock ap-southeast-1 with a regional endpoint, or equivalent. For the demo phase with synthetic data, any API is fine; switch before real patient data.

---

## 6. Review UI

Single page, two panes:
- **Left:** field list. Each row = label, editable value, status pill (green extracted / amber inferred / red missing), source snippet in small text below.
- **Right:** live PDF preview (or just skip preview in v1 — a "Download filled PDF" button after approval is enough).
- Doctor edits inline, clicks **Approve & Generate**.

Don't gold-plate this. A plain React page with a table of inputs ships in a day.

---

## 7. PDF fill & cleanup

- `pypdf` writes values into AcroForm fields; `set_need_appearances_writer` so values render everywhere.
- Checkboxes: set the field's export value (dump it from the PDF; it's often `/Yes` but not always).
- After download: delete the record, redaction map, and filled PDF from the server. Retention = zero in MVP. This is both PDPA hygiene and one less thing to build (no persistence layer for patient data — only form schemas and usage counts persist).

---

## 8. Stack & repo layout

```
formfill/
├── backend/            # FastAPI
│   ├── main.py         # routes: POST /claims, POST /claims/{id}/approve
│   ├── redaction.py    # Section 3 — build & test this FIRST
│   ├── mapping.py      # LLM call + output validation (Pydantic)
│   ├── pdf_fill.py     # pypdf fill logic
│   └── schemas/        # one JSON per insurer form
├── frontend/           # React + Vite, single review page
├── forms/              # source PDFs
└── tests/
    ├── test_redaction.py    # golden set, round-trip, adversarial
    └── fixtures/            # synthetic patient notes (NO real data in repo)
```

FastAPI + Pydantic + pypdf + React. Postgres not needed for MVP — in-memory session store or SQLite for schemas/counters.

---

## 9. Build order

| Day | Deliverable |
|---|---|
| 1 | Collect 3 real forms from Dad. Dump their AcroForm fields. Write 5 synthetic patient notes in his note style. |
| 2 | `redaction.py` + full test suite passing. |
| 3 | Form schemas (JSON) for all 3 forms, descriptions written carefully. |
| 4–5 | `mapping.py`: LLM call, Pydantic validation, re-merge. Iterate prompt against synthetic notes until extraction is solid. |
| 6 | `pdf_fill.py`: filled PDF renders correctly in Adobe/Preview/Chrome. |
| 7–8 | FastAPI routes + React review page wired end-to-end. |
| 9 | End-to-end run on synthetic data. Fix everything ugly. |
| 10 | Demo to Dad with synthetic patient. Then: switch inference to SG region, run first real patient **with him at the keyboard**. |
| 11+ | Watch him use it on 5 real claims. Log every field he corrects — that correction log is your prompt-improvement dataset and your accuracy pitch to the next doctor. |

---

## 10. Guardrails (non-negotiable even in MVP)

1. No real patient data until inference is in-region and redaction tests pass.
2. Never auto-submit anything to an insurer. Output is always a PDF the doctor reviews and signs.
3. A field with `status != "extracted"` renders amber/red and requires an explicit click to accept.
4. No patient data in logs, error messages, or analytics. Test this deliberately (grep your logs after a run).
5. Synthetic fixtures only in the repo. `.gitignore` anything under `forms/output/`.
