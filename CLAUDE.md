# FormFill — working notes for Claude

Product docs live in `README.md` (what it does, privacy model, how to add an
insurer form). **Read that first.** This file records decisions, current
state, and the traps — the things not derivable from the code.

Stack: FastAPI + pypdf backend, React/Vite frontend, Anthropic structured
output. Repo `EdwardThng/DocBot` (private). Pilot user is the owner's father,
a Singapore GP.

---

## Status as of 2026-07-28 (HEAD `8c0f582`)

| Piece | State |
|---|---|
| Pipeline: redact → LLM map → doctor review → PDF fill | Working, 78 offline tests pass |
| AIA GHS claim (24 fields) + Great Eastern GHS claim (15 fields) | Live, smoke-tested end to end with a real LLM call |
| React UI: 3-step flow, form picker, review screen | Rebuilt for first-time clarity |
| Single-origin serving (FastAPI serves `frontend/dist`) | Working locally, verified |
| Fly deploy | **Live** at https://formfill-backend.fly.dev — 1 machine in `sin`, health check passing |
| `ANTHROPIC_API_KEY` | **Not set anywhere** — no local env var, no Fly secret. `POST /claims` fails until set |

Note: commit `ec7c09c` is named "full deployment on fly.io" but only adds the
static mount to `main.py` — the actual deploy happened later, on 2026-07-30.
Verify deploy state with `flyctl`, not commit titles.

**Always deploy with `fly deploy --ha=false`.** Fly's default adds a second
machine for high availability, which silently breaks this app: a claim created
on machine A 404s when the approve request lands on machine B. `fly.toml`'s
`min_machines_running = 1` does *not* prevent it. The first deploy created two
machines and needed `fly scale count 1` to undo. Check with `fly status` after
every deploy.

---

## Decisions and why

**One app on Fly, not Vercel + Fly.** The frontend is built into the image and
served by FastAPI, so there is one URL and one deploy. This removed the CORS
allowlist and `VITE_API_URL` from the critical path — two fewer things to
misconfigure during a pilot. `FORMFILL_ALLOWED_ORIGINS` still works and is
still wired up, in case the frontend is ever split out again.

**Singapore region, exactly one always-on machine.** Claims live in an
in-memory store (a privacy feature, not an oversight), so a second machine or
an auto-stop mid-review would split or lose a claim. `fly.toml` pins
`min_machines_running = 1` and `auto_stop_machines = "off"`.

**Field labels live in the schema JSON, not the UI.** Each field carries a
`label` ("ICD-10 code") alongside its `description` (the instruction the model
follows). The review screen renders `label`; raw ids like `icd_code` must
never reach the doctor. `FormField.display_label` falls back to a prettified
id so a half-written schema still renders.

**The dev fixture is hidden, not removed.** `dev_sample.json` has
`"internal": true`; `GET /forms` filters it out so a doctor is never offered a
fake form, but claims can still be created against `dev_sample_v1` by id,
which is what the API tests do.

**Doctors confirm, they don't just read.** Anything not directly `extracted`
requires an explicit confirm click before the PDF can be generated. Editing a
value counts as confirming it. Do not "helpfully" pre-confirm inferred fields.

**Auto-filling demographics from the clinic CMS was investigated and
deferred.** Recommendation stands: paste-and-parse (extract NRIC/DOB/phone
from one pasted block using the regexes already in `redaction.py`) before any
CMS integration. If integration happens, it must run *inside* the clinic — a
local agent or browser extension — never the Fly server holding standing
credentials to a patient database. See conversation history for the full
comparison (ClinicAssist / Assurance Technology, NEHR via Synapxe GPConnect).

---

## Traps

**Structured-output grammar limits.** The Anthropic API compiles the JSON
schema to a grammar with two hard, undocumented limits: max 16 union-typed
parameters (`anyOf` / nullable / type arrays) and a bounded total grammar
size. A 20+ field form blows both under a per-field-object shape. `mapping.py`
therefore emits **one array of `{id, value, status, source}` entries with the
field ids as an enum**, all values as strings, coerced back on parse. Do not
"simplify" this back to per-field properties — it will 400 on the real forms.
`test_output_schema_has_no_union_types` guards it.

**pypdf misreports `/MaxLen` on comb fields.** `PdfReader.get_fields()`
returns `MaxLen: None` where the raw annotation actually has `MaxLen=20`. Comb
fields render only a clipped tail when the value exceeds the cell count (this
mangled real values on the Great Eastern form: `S1234567D` → `345670`).
`pdf_fill._flatten_comb_fields` drops the comb + scroll-lock flags and
`/MaxLen` on any text field being filled. Tests must read raw annotations via
`page["/Annots"]`, not `get_fields()`.

**Duplicate PDF field names across pages.** Names like `Policy No` and
`Company Name` repeat on pages 2 and 3 of the AIA form. When adding fields,
verify the page and rect, not just the name.

**Two fill modes.** `fill_mode: "acroform"` writes into the PDF's own fields
(AIA GHS, GE GHS — official fillable PDFs). `fill_mode: "overlay"` stamps text
at coordinates onto flat CamScanner scans that have no fields at all
(Prudential, Henner, AIA Medical Report). Overlay boxes are **points from the
page top-left**, not PDF's bottom-left origin — the conversion happens once in
`overlay_fill._box_to_pdf_rect`.

**Never eyeball overlay coordinates — use the proof loop.**
`python scripts/calibrate_overlay.py <pdf> <out>` renders each page with a
labelled point grid; `--proof <schema.json> <out>` stamps every box with its
own field id so a misplaced box is obvious. Two traps this caught, both of
which will recur on any new overlay form:

- The embedded page scan does **not** fill the mediabox — it is inset. Boxes
  measured off an extracted page image are systematically ~30pt out. Only the
  rasterized proof render is authoritative.
- Adjacent boxes are usually *different questions*, so text overflow puts an
  answer under the wrong heading. `_hard_wrap` breaks mid-token and clips
  rather than spilling; `test_unbreakable_token_never_exceeds_box_width`
  guards it.

`scripts/calibrate_overlay.py` needs PyMuPDF (`pip install pymupdf`), which is
deliberately **not** in `backend/requirements.txt` — the server never
rasterizes.

**All three overlay forms are fully calibrated.** AIA Medical Report covers all
7 pages (96 boxes). Three blocks are skipped on purpose, not overlooked: the
Q8 dental tooth-number diagram, Section E organ transplantation (completed by
a transplant recipient's and donor's doctors, not a GP), and every Yes/No
checkbox pair. The doctor's signature and signing date are also left blank — a
pre-printed date that disagrees with the signature date is worse than a blank.

**Schemas deliberately skip some fields.** Great Eastern's tiny
day/month/year triplet boxes and ambiguous Yes/No checkboxes are left for the
doctor to complete by hand after printing. This is intentional, not an
omission to "fix".

---

## Guardrails — do not relax these

- Demographics never reach the LLM. They are copied onto the form
  deterministically and double as the redaction dictionary.
- The token→value map stays in server memory; claims are in-memory only,
  deleted on download, purged after 1h.
- No patient data in logs or error messages. LLM failures return a generic
  `"LLM call failed"`.
- **No real patient data until inference is confirmed in-region.** The default
  `claude-opus-4-8` via the standard API is not SG-region.
  `FORMFILL_MAPPING_MODEL` / `FORMFILL_SWEEP_MODEL` are the switch point.
  Synthetic or anonymised notes only until then.
- The API key belongs in a Fly secret, never in a repo file, and never pasted
  into a chat transcript (including via the `!` prefix, which is logged).
- Repo fixtures are synthetic only.

---

## Commands

```bash
# tests (offline, no API key needed)
./.venv/Scripts/python.exe -m pytest -q

# backend dev
./.venv/Scripts/python.exe -m uvicorn main:app --app-dir backend --port 8000

# frontend dev (expects backend on :8000)
cd frontend && npm run dev            # http://localhost:5173

# production shape locally: build the frontend, then hit the backend alone
cd frontend && npm run build          # backend then serves it at /
./.venv/Scripts/python.exe -m uvicorn main:app --app-dir backend --port 8100

# dump a PDF's field names when adding a form
./.venv/Scripts/python.exe backend/pdf_fill.py forms/your_form.pdf
```

`flyctl` is installed at `~/.fly/bin/flyctl.exe` (not on PATH). The `!` prefix
in Claude Code runs **Bash**, not PowerShell.

The backend serves the frontend only if `frontend/dist` exists — that is why
local dev without a build still works, and why the Dockerfile builds it in a
node stage.

---

## Next steps

1. **Set the Fly secret** — the only thing standing between the live site and
   a working claim: `fly secrets set ANTHROPIC_API_KEY=...`. Must be run by
   the owner in their own terminal, never through Claude Code's `!` prefix
   (which writes the command into the transcript).
2. **Paste-and-parse demographics** — the agreed next feature. One pasted
   block from ClinicAssist fills name/NRIC/DOB/phone instead of six fields.
3. **SG-region inference** before any real patient note.
4. Deferred: coordinate-overlay fill for the three scanned forms.

---

## Working style

**HARD RULE — commit and push after every file change.** Every edit, even a
one-line one, gets committed and pushed to GitHub *before* the next file is
touched. Do not batch edits into one commit at the end of a task. The owner
reviews as the work lands, so an unpushed change is invisible to them.

Consequences to accept, not work around: the history will have many small
commits, and intermediate commits may not pass tests (an import added before
the module that uses it, and so on). That is fine — correctness is judged at
the end of the task, not per commit.

Prefer correcting a wrong premise plainly over going along with it.
