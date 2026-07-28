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
| Fly deploy | **Not deployed.** Blocked on `fly auth login` (needs a browser) |
| `ANTHROPIC_API_KEY` | **Unset** — the owner removed it. `POST /claims` fails until restored |

Commit `ec7c09c` is named "full deployment on fly.io" but only adds the static
mount to `main.py`. Nothing has ever been deployed; the Dockerfile has never
been built (Docker Desktop was not running, so Fly's remote builder will
compile it for the first time during the first `fly deploy`).

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

**Three of the clinic's five forms cannot be filled.** Prudential, Henner and
the AIA Medical Report are flat CamScanner scans with zero AcroForm fields,
and no public fillable versions exist. They sit in `forms/scans_unsupported/`
and need a coordinate-overlay fill feature or stay manual. The two live forms
are official fillable PDFs downloaded from the insurers.

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

1. **Deploy.** Needs the owner's browser: `flyctl auth login`, then
   `fly apps create` (the name `formfill-backend` may collide — Fly app names
   are global), `fly secrets set ANTHROPIC_API_KEY=...`, `fly deploy`. Watch
   the node build stage; it has never run.
2. **Restore `ANTHROPIC_API_KEY` locally** if the full flow needs exercising
   before deploy — screens 2 and 3 are unreachable without it.
3. **Paste-and-parse demographics** — the agreed next feature. One pasted
   block from ClinicAssist fills name/NRIC/DOB/phone instead of six fields.
4. **SG-region inference** before any real patient note.
5. Deferred: coordinate-overlay fill for the three scanned forms.

---

## Working style

Ship in small steps and push after each finished part; the owner reviews as it
goes rather than at the end. Prefer correcting a wrong premise plainly over
going along with it.
