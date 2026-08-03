# FormFill

**LLM-assisted insurance form filling for medical clinics — with privacy-first redaction and mandatory doctor review.**

FormFill turns a pasted clinical note into a filled insurance claim PDF in minutes. A doctor pastes the patient's clinical notes, an LLM maps the clinical information onto the insurer's form fields, the doctor reviews and corrects every proposed value, and a filled PDF is downloaded. The server retains nothing afterwards.

---

## What it does

1. **Ingest** — The consultation is pasted in one block. Patient demographics (name, NRIC, DOB, phone, address, policy number, insurer) are pulled back out of it **by pattern, never by a model** — that ordering is what the next step depends on — and shown as editable fields for the doctor to correct or complete.
2. **Redact** — Every identifier is stripped from the clinical text *before* it reaches the LLM, in three passes:
   - **Dictionary pass:** the entered demographics are removed from the note (name in any ordering or partial form, NRIC even with stray spaces, phone in any separator format, DOB in common renderings, address, policy number), each replaced with a token like `[PATIENT]` or `[NRIC]`.
   - **Pattern pass:** NRIC/FIN, Singapore phone number, and email regexes catch identifiers that were *not* entered — family members, other patients mentioned in the note.
   - **LLM sweep (optional):** a small, cheap model is asked whether any names, ID numbers, phone numbers, or addresses survived the first two passes; anything it finds is tokenized too.
3. **Map** — One structured-output LLM call receives the form's field definitions and the redacted note. For every field it must return a value, a status — `extracted` (stated in the note), `inferred` (reasonable clinical inference), or `missing` — and the verbatim source snippet that supports the value. The model cannot invent facts silently: malformed or omitted answers are downgraded to `missing`.
4. **Review** — The doctor sees every field with its status pill (green/amber/red) and source snippet. Values can be edited inline. Any field that was not directly extracted **requires an explicit accept click** before the form can be generated.
5. **Fill & download** — Approved values are written into the insurer's fillable PDF (AcroForm) and streamed back as a download. The claim and all patient data are deleted from the server the moment the download completes.

### Privacy model

- **Demographics never reach the LLM.** They are copied onto the form deterministically and double as the redaction dictionary. This extends to *finding* them: the paste is split by pattern, because a model asked to do it would have read the patient's name before the dictionary that redacts the name existed.
- **The LLM only ever sees de-identified text.** The token→value mapping lives in server memory for the duration of the request flow and is never sent to any model or written to logs.
- **Zero retention.** Claims exist only in an in-memory store, are deleted on download or discard, and are purged automatically after one hour. No database holds patient data.
- **No silent guesses.** Every AI-proposed value carries its supporting quote or a `missing` flag, and nothing reaches a PDF without doctor approval. A redaction token can never leak into a generated PDF — it is blocked at three independent layers.
- **No auto-submission.** The output is always a PDF that the doctor reviews, signs, and submits themselves.

---

## Architecture

```
frontend/   React + Vite single-page review UI
extension/  Chrome side panel — fills insurer web forms in place, never submits
backend/    FastAPI service
  ├── demographics.py  one pasted block -> demographic fields (no LLM, ever)
  ├── redaction.py   identifier stripping + re-merge (no LLM required)
  ├── mapping.py     LLM field extraction + validation + claim assembly
  ├── pdf_fill.py    AcroForm filling (pypdf) + form field dump tool
  ├── main.py        HTTP API and in-memory claim store
  └── schemas/       one JSON schema per insurer form
forms/      source fillable PDFs (one per schema)
scripts/    dev utilities (synthetic sample form generator)
tests/      pytest suite (runs fully offline — LLM calls are stubbed)
```

### API

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/forms` | List available form schemas |
| `POST` | `/parse` | Split one pasted block into demographic fields. Patterns only — no model, nothing stored |
| `POST` | `/map` | Redact + extract for the browser extension. Stateless: no `claim_id`, nothing retained |
| `POST` | `/map-live` | Same, against a page's own field labels, for a form no schema describes. A successful fill then drafts that schema |
| `POST` | `/claims` | Redact + extract; returns review rows and a `claim_id` |
| `GET` | `/claims/{id}` | Re-fetch review rows |
| `POST` | `/claims/{id}/approve` | Fill the PDF with final values; returns the PDF and deletes the claim |
| `DELETE` | `/claims/{id}` | Discard a claim |
| `GET` | `/health` | Liveness + loaded form count |

---

## Running it

### Prerequisites

- Python 3.11+
- Node.js 20+
- An Anthropic API key (`ANTHROPIC_API_KEY`)

### Backend

```bash
# from the repo root
python -m venv .venv
# Windows:
.venv\Scripts\pip install -r backend/requirements.txt
# macOS/Linux:
.venv/bin/pip install -r backend/requirements.txt

# set your API key (Windows PowerShell / macOS-Linux)
$env:ANTHROPIC_API_KEY = "sk-ant-..."
export ANTHROPIC_API_KEY="sk-ant-..."

# run the API on port 8000
.venv\Scripts\python -m uvicorn main:app --app-dir backend --port 8000
```

### Frontend

```bash
cd frontend
npm install
npm run dev          # dev server on http://localhost:5173
```

The UI expects the backend at `http://localhost:8000`; point it elsewhere with `VITE_API_URL`:

```bash
VITE_API_URL=https://your-backend.example.com npm run build
```

### Configuration

| Environment variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Required for the mapping call and LLM sweep |
| `FORMFILL_MAPPING_MODEL` | `claude-opus-4-8` | Model for form-field extraction |
| `FORMFILL_SWEEP_MODEL` | `claude-haiku-4-5` | Model for the redaction safety sweep |
| `FORMFILL_DISABLE_SWEEP` | unset | Set to `1` to skip the LLM redaction sweep |
| `FORMFILL_SHOW_INTERNAL` | unset | Set to `1` to offer internal test schemas in `GET /forms`. Never set this where a doctor works |
| `VITE_API_URL` | `http://localhost:8000` | Backend URL baked into the frontend |

### Tests

The entire suite runs offline — no API key needed:

```bash
.venv\Scripts\python -m pytest        # Windows
.venv/bin/python -m pytest            # macOS/Linux
```

Coverage includes a golden set of synthetic clinical notes asserting zero identifiers survive redaction, adversarial redaction cases, PDF fill round-trips, and the full API flow with the LLM stubbed.

---

## Adding a new insurer form

1. Drop the insurer's **fillable (AcroForm) PDF** into `forms/`.
2. Dump its field names and checkbox export values:
   ```bash
   .venv\Scripts\python backend/pdf_fill.py forms/your_form.pdf
   ```
3. Write a JSON schema in `backend/schemas/` mapping each PDF field to either
   a demographic (`"source": "demographics.full_name"`) or an LLM-extracted
   field (`"source": "llm"` plus a `description`). The `description` is the
   instruction the model follows — write it the way you would brief a
   colleague filling in the form.
4. Restart the backend. The form appears in `GET /forms` and the UI dropdown.

A synthetic sample form (`dev_sample_v1`) ships with the repo so the pipeline can be exercised without any real insurer forms; regenerate its PDF with `python scripts/make_dev_form.py`.

**For a web form, you do not have to write the schema first.** Fill it once with
the extension's fallback — it maps against the page's own field labels — and it
hands back a draft schema to review and drop into `backend/schemas/`. Read it
before committing: the field descriptions start out as the page's own wording,
and a description is what tells the model what a question *means*.

---

## Limitations

- **Three fill targets, and a schema declares which.** `acroform` writes into a
  fillable PDF's own fields, `overlay` stamps text at coordinates onto a flat
  scan, and `web` fills an insurer's own web form in place through the browser
  extension. A `web` schema has no PDF, so there is nothing to download.
- **In-memory claim store.** Run a single backend process; claims do not survive a restart (by design — this is a privacy feature as much as a limitation).
- **Data residency is your responsibility.** If regulations require in-region inference, point the model configuration at a regional endpoint before processing real patient data, and verify redaction tests pass in your environment.
- FormFill assists with form completion; the reviewing doctor remains responsible for the accuracy of every submitted form.
