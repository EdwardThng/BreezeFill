# BreezeFill

**LLM-assisted insurance form filling for medical clinics — with privacy-first redaction and mandatory doctor review.**

BreezeFill turns a pasted clinical note into a filled insurance claim in minutes. A doctor pastes the consultation into a browser side panel sitting beside the insurer's own form, an LLM maps the clinical information onto that form's fields, the doctor reviews and corrects every proposed value, and the accepted ones are written into the page — or, for an insurer that still sends a PDF, into a filled PDF to download. It never submits, and the server retains nothing afterwards.

---

## What it does

1. **Ingest** — The consultation is pasted in one block. Patient demographics (name, NRIC, DOB, phone, address, policy number, insurer) are pulled back out of it **by pattern, never by a model** — that ordering is what the next step depends on — and shown as editable fields for the doctor to correct or complete.
2. **Redact** — Every identifier is stripped from the clinical text *before* it reaches the LLM, in three passes:
   - **Dictionary pass:** the entered demographics are removed from the note (name in any ordering or partial form, NRIC even with stray spaces, phone in any separator format, DOB in common renderings, address, policy number), each replaced with a token like `[PATIENT]` or `[NRIC]`.
   - **Pattern pass:** NRIC/FIN, Singapore phone number, and email regexes catch identifiers that were *not* entered — family members, other patients mentioned in the note.
   - **LLM sweep (optional):** a model is asked whether any names, ID numbers, phone numbers, or addresses survived the first two passes; anything it finds is tokenized too. It runs on a top-tier model rather than a cheap one — it is the last line of defence before text reaches the mapping call, so it is worth the rate.
3. **Map** — One structured-output LLM call receives the form's field definitions and the redacted note. For every field it must return a value, a status — `extracted` (stated in the note), `inferred` (reasonable clinical inference), or `missing` — and the verbatim source snippet that supports the value. The model cannot invent facts silently: malformed or omitted answers are downgraded to `missing`.
4. **Review** — The doctor sees every field with its status pill (green/amber/red) and source snippet. Values can be edited inline. Any field that was not directly extracted **requires an explicit accept click** before the form can be generated.
5. **Fill** — For a web form the extension writes the approved values into the insurer's own page, in the browser; the doctor submits it. For a PDF form the values are posted back, written into the AcroForm (or stamped onto a flat scan), and streamed back as a download. Either way the server keeps nothing.

### Privacy model

- **Demographics never reach the LLM.** They are copied onto the form deterministically and double as the redaction dictionary. This extends to *finding* them: the paste is split by pattern, because a model asked to do it would have read the patient's name before the dictionary that redacts the name existed.
- **The LLM only ever sees de-identified text.** The token→value mapping lives in server memory for the duration of the request flow and is never sent to any model or written to logs.
- **Zero retention of patient data, literally.** Every endpoint is stateless about patients: the server holds nothing between requests, so patient data exists only for the duration of the request that carried it in. There is no claim store, no session and no id.

  **One thing does persist, and it is not a patient.** The *form bank* keeps blank insurer forms uploaded by doctors, and the schemas derived from them — a published document the insurer hands to anyone who asks, plus a description of where its boxes are. It exists because reading a form costs a model call per page and the answer is identical for everyone who ever sends in that same form. A PDF that already has answers in it is refused outright, because that is somebody's completed claim (`form_bank.intake_guard`). If you are auditing this claim, that check is the line, and `tests/test_upload_route.py` asserts such an upload reaches storage as zero files.
- **No silent guesses.** Every AI-proposed value carries its supporting quote or a `missing` flag, and nothing reaches a PDF without doctor approval. A redaction token can never leak into a generated PDF — it is blocked at three independent layers.
- **No auto-submission.** BreezeFill fills and stops. On a web form the approved values are written into the insurer's own page and the doctor submits it; on a PDF form the output is a file the doctor reviews, signs and submits. Nothing is ever sent to an insurer on their behalf.

---

## Architecture

```
frontend/   The website: landing page, interactive demo, and the older
            PDF claim UI kept at #/app
  ├── Landing.tsx   what the product is, and what it refuses to do
  ├── Demo.tsx      one synthetic claim, walked step by step, no backend
  └── ClaimApp.tsx  paste -> review -> filled PDF (unadvertised, still works)
extension/  Chrome side panel — fills insurer web forms in place, never submits
backend/    FastAPI service
  ├── demographics.py  one pasted block -> demographic fields (no LLM, ever)
  ├── redaction.py   identifier stripping + re-merge (no LLM required)
  ├── mapping.py     LLM field extraction + validation + claim assembly
  ├── pdf_fill.py    AcroForm filling (pypdf) + form field dump tool
  ├── main.py        HTTP API. Every route stateless — nothing is held
  │                  between requests, so there is nothing to purge
  └── schemas/       one JSON schema per insurer form
forms/      source fillable PDFs (one per schema)
assets/logo/ every sized copy of the logo, named for where it is used;
            all generated from one master by scripts/make_logo_assets.py
scripts/    dev utilities (sample form generator, overlay calibration,
            logo asset generation)
tests/      pytest suite (runs fully offline — LLM calls are stubbed)
```

### API

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/forms` | List the curated form schemas. Uploaded forms are deliberately absent — one clinic's upload is not offered to another |
| `POST` | `/forms/upload` | A blank insurer PDF in, a mappable schema out. Reads the PDF's own AcroForm boxes when it has them, and renders its pages for the model to read when it does not. Refuses a PDF that already has answers in it |
| `POST` | `/forms/known` | "Have you read this form before?", answered from a SHA-256 with no upload. A 404 means no, and the caller follows it with the real upload |
| `POST` | `/forms/{id}/proof` | The blank form with every box drawn on it, stamped with its own field id. The review step for geometry, and only meaningful for a form read from a scan |
| `POST` | `/notes/extract` | A consultation note that arrived as a PDF, as text. The paste box by another route — it extracts and stops |
| `POST` | `/parse` | Split one pasted block into demographic fields. Patterns only — no model, nothing stored |
| `POST` | `/map` | Redact + extract against a named schema. Stateless: no `claim_id`, nothing retained. Kept for the PDF UI; the extension no longer uses it |
| `POST` | `/map-redacted` | **What the extension actually calls.** Takes no `PatientRecord` — the panel redacted in the tab and kept the token map — so the server never receives the identifiers at all. Every question on the page, each carrying the best instruction available: a matching schema's `description` where one exists, the page's own wording where none does |
| `POST` | `/map-live` | The same shape but accepting an unredacted note. **No shipping code calls it** — the panel moved to `/map-redacted` when redaction moved into the browser. Live and reachable, so treat it as a route rather than dead code. Refuses with `422` when nothing on the page is labelled and `413` when there are more questions than one call can carry |
| `POST` | `/forms/{id}/pdf` | Fill the PDF with final values and return it. Send every field — nothing is remembered from the mapping call. For an uploaded form, send the schema and the blank PDF back too |
| `GET` | `/health` | Liveness, loaded form count, and which form bank is in use. `"NullBank"` means nothing is being cached |
| `POST` | `/checkout` | Open a Stripe Checkout for the one plan this product sells. Takes no arguments — the price, quantity and return address are all decided server-side, where a caller cannot reach them |
| `POST` | `/licence/claim` | A paid Stripe checkout session in, a signed licence token out. The server asks Stripe whether that session was really paid before it signs anything, so minting is on proof of payment rather than on demand |
| `GET` | `/download/breezefill-extension.zip` | The extension, zipped from the running source so a download is never older than the server |

FastAPI also serves `/docs`, `/redoc` and `/openapi.json`, and **they are
public in production** — `https://api.breezefill.com/docs` returns 200. They
expose no data, only the API's shape, but that shape now includes the licence
and checkout routes. Disabling them is one argument to `FastAPI(...)`; leaving
them is a decision rather than an oversight, and it should be made rather than
inherited.

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

### Website

```bash
cd frontend
npm install
npm run dev          # dev server on http://localhost:5173
```

Three screens, routed by hash so the backend's catch-all static mount never
sees them: `#/` is the landing page, `#/demo` is a walkthrough of one synthetic
claim that talks to nothing, and `#/app` is the older PDF claim UI — kept
because not every insurer sends a link, and those five forms have no other
interface.

The PDF UI expects the backend at `http://localhost:8000`; point it elsewhere with `VITE_API_URL`:

```bash
VITE_API_URL=https://your-backend.example.com npm run build
```

### Configuration

| Environment variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Required for the mapping call and LLM sweep |
| `FORMFILL_MAPPING_MODEL` | `claude-opus-5` | Model for form-field extraction |
| `FORMFILL_SWEEP_MODEL` | `claude-opus-5` | Model for the redaction safety sweep. Top-tier on purpose — drop it to a cheaper model here if cost bites |
| `FORMFILL_INFERENCE_GEO` | unset | Where inference runs. The API accepts only `us` and `global`; there is no Singapore value, so in-region SG inference needs Bedrock `ap-southeast-1` instead |
| `FORMFILL_DISABLE_SWEEP` | unset | Set to `1` to skip the LLM redaction sweep |
| `FORMFILL_SHOW_INTERNAL` | unset | Set to `1` to offer internal test schemas in `GET /forms`. Never set this where a doctor works |
| `VITE_API_URL` | `http://localhost:8000` | Backend URL baked into the frontend |

### Tests

Three suites, all offline — no API key needed for any of them:

```bash
.venv\Scripts\python -m pytest    # backend
npm test                          # browser extension (from the repo root)
cd frontend && npm test           # website
```

Coverage includes a golden set of synthetic clinical notes asserting zero identifiers survive redaction, adversarial redaction cases, PDF fill round-trips, and the full API flow with the LLM stubbed.

---

## Adding a new insurer form

**Most of the time you do not.** A doctor uploads the blank form at `#/app` and
the server works out what it is: a hand-authored schema when the PDF is one
this repo already describes (matched on the file's own bytes), the form bank
when somebody has sent that form in before, and a fresh read when nobody has. A
fresh read uses the PDF's own AcroForm boxes where it has them, and renders its
pages for the model to locate the boxes where it does not.

Two things worth knowing about a form read that way:

- **Expect a messier field list than a hand-authored schema.** Great Eastern's
  own GHS claim carries 143 raw AcroForm fields where the curated schema has
  15, and names them things like `undefined_2` and four separate `Day` boxes.
  What each is for is printed on the page beside it, which is what the intake
  reads.
- **A form read from a SCAN has geometry nobody measured.** Check it with
  `POST /forms/{id}/proof`, which stamps every box with its own field id onto
  the form itself. The website offers this automatically for scanned forms.

**Hand-author a schema when a form is worth doing properly** — the pilot's
common forms, anything where the derived version reads badly:

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
4. Restart the backend. The form appears in `GET /forms`, and — because
   `CURATED_BY_PDF` indexes every curated form by its PDF's hash — a doctor who
   uploads that same file gets your schema rather than a derived one.

A synthetic sample form (`dev_sample_v1`) ships with the repo so the pipeline can be exercised without any real insurer forms; regenerate its PDF with `python scripts/make_dev_form.py`.

**For a web form, you do not have to write the schema first.** The extension
fills whatever questions are on the page whether or not one exists — a schema
only makes the answers sharper. To write one, take a learn-mode dump of the page
(`extension/learn/dump.js`) and author the schema from that. The panel used to
offer a drafted schema after a schema-free fill; that was removed on 2026-08-17,
because it asked a doctor to review JSON.

Author a web schema's labels from **the page's own wording**, not from the
equivalent PDF form's. The join between schema fields and live controls
compares words rather than meaning, so "Date of first consultation" does not
match "7. When did the patient first consult you" — the control still gets
filled, just without the sharper instruction.

---

## Limitations

- **Three fill targets, and a schema declares which.** `acroform` writes into a
  fillable PDF's own fields, `overlay` stamps text at coordinates onto a flat
  scan, and `web` fills an insurer's own web form in place through the browser
  extension. A `web` schema has no PDF, so there is nothing to download.
- **A form read from a scan has geometry no human measured.** An uploaded PDF
  with no fillable boxes is read by rendering its pages and asking the model
  where the boxes are. Obvious nonsense is refused, but a box fifteen points too
  high produces a sensible answer printed across the question above it, and the
  review screen renders that exactly like a correct one. `POST /forms/{id}/proof`
  is the check, and the website offers it automatically for these forms.
  **Whether the model locates boxes well on a real insurer form is not yet
  established** — every test on that path feeds a stubbed client.
- **Nothing survives a request.** Losing the browser tab mid-review means starting the claim again, because the server has no copy to resume from. That is the retention model working, not a gap in it.
- **Data residency is your responsibility.** If regulations require in-region inference, point the model configuration at a regional endpoint before processing real patient data, and verify redaction tests pass in your environment.
- BreezeFill assists with form completion; the reviewing doctor remains responsible for the accuracy of every submitted form.
