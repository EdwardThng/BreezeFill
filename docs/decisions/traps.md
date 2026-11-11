# Traps

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

**The side panel API has two traps, and they compound.** Both found on Chrome
150, 2026-08-03, and each looks like a console warning while silently breaking
page access.

1. `chrome.sidePanel.setPanelBehavior()` throws `Error: No SW` — from the
   service worker's **top level and from `onInstalled` alike**. The API will
   not attach a behaviour to a worker it does not consider active, and no
   moment was found at which it does. **Do not call it.** `background.js`
   does not, and the comment there explains why; the tempting "fix" of moving
   the call to a different lifecycle event has already been tried and failed.
2. `openPanelOnActionClick: true` opens the panel but does **not** grant
   `activeTab`: Chrome handles the click itself so `action.onClicked` never
   fires, and a click that does not reach the extension is not an invocation.
   Use `action.onClicked` → `sidePanel.open({tabId})` instead.

They compound because the behaviour is **persisted per-extension**. Trap 1
means the fix for trap 2 cannot be applied in code at all, so an install that
once set the flag `true` keeps swallowing clicks — and the only symptom is the
panel saying it has no access to a tab the doctor is plainly looking at. The
only way to clear a stored `true` is to **remove the extension and load it
again**; a plain reload keeps the flag. `false` is the default, so a clean
install needs no call.

**A default backend URL is a version pin (2026-08-05).** The trap that cost the
most, because nothing in the symptoms pointed at it. A tester was sent the
product and reported two unrelated-looking failures: the panel called itself by
the old product name, and Map returned 422. Neither was a bug in this
repository. `DEFAULT_API_BASE` still aimed at Fly, Fly had not been redeployed
since 2026-08-03, and its `/download` therefore served the pre-rename
extension — so the tester ran a two-day-old build against a two-day-old
backend, and every symptom was downstream of that.

The tell, for next time: **an error string that no longer exists in the source
means the reporter is not running the source.** Grep for it before debugging
anything else — `git ls-files | xargs grep -l "<the exact string>"` settles it
in one command.

Aim a default at a deployment nobody redeploys and you ship that day's build
forever. Fly is destroyed now, but the same applies to any URL that ends up in
`DEFAULT_API_BASE`: it is a version number in disguise.

**A refusal the backend explained must not arrive as a bare status code.** Both
live-mapping refusals used to surface as "Request failed (422)". The
too-many-fields case is now **413** so the panel can tell them apart from the
status line alone, and each maps to a sentence naming the cause. The panel must
**not** read the response body to distinguish them: FastAPI's own validation
failures are 422 too and they quote the offending input, which on `/map-live`
contains the clinical note.

**Three traps cost attempts on the first Vercel deploy (2026-08-05).** None is
derivable from the code, and all three recur on a fresh clone or a rebuild.

1. **`pyproject.toml` breaks the build.** Vercel's Python runtime is uv-based,
   and uv treats *any* `pyproject.toml` as a project manifest. This one is
   three lines of pytest config with no `[project]` table, so `uv lock` fails
   and the deploy dies before bundling: ``No `project` table found``. It is
   excluded in `.vercelignore` — which has to be `.vercelignore` and not
   `excludeFiles`, because the latter trims the bundle *after* upload and this
   fails earlier than that. Do not "fix" it by adding a `[project]` table: that
   gives uv a second dependency list to resolve against, and
   `test_requirements_sync.py` exists because one duplicate is already one too
   many.
2. **A UTF-8 BOM makes a JSON file invalid, and npm hides it.** `package-lock.json`
   was committed with `EF BB BF`; npm tolerates it, Vercel does not, and the
   deploy reports `Error while parsing config file` against a file that looks
   fine in every editor. This is the PowerShell trap already recorded below
   under toolchain quirks — `>` and `Out-File` default to UTF-8 **with** BOM
   here — landing in a tracked file. To sweep: check `head -c 3` of every
   tracked `.json` for `efbbbf`. Only that one file had it.
3. **`vercel curl` takes the first path-like token as the request path**, not
   the URL you meant. `-o /dev/null` therefore fetches `/dev/null` and returns
   a 404 that looks exactly like a broken route — this produced a phantom 404
   on `/download` twice, and was confirmed by requesting `$url/dev/null` and
   getting the identical 22-byte body. **Put the URL first and never pass
   `-o`.** A 22-byte `{"detail":"Not Found"}` is FastAPI's generic 404; the
   route's own "extension not bundled" reply is 48 bytes, so the length alone
   tells you whether the route was even reached.

**`options` must be checked before `type`, in four places (2026-08-06).** The
common insurer shape is a question answered by picking one of a named set, and
its control is often a checkbox or radio rather than a `<select>`. Anything
that branches on type first makes `options` unreachable for it:

- `_coerce_answer` demanded `"true"/"false"` for a checkbox field, so a model
  answering `"Emergency"` collapsed to `missing` before the option list was
  consulted.
- Both review screens rendered a tick box for such a question, which cannot
  represent the answer — and `ReviewScreen.approve()` sent `false` for every
  real one.

All four now test `field.options` first. The system prompt says so explicitly
too, because the type line otherwise contradicts it.

**A sibling-shape heuristic finds question rows, not entries.** `instanceIndexOf`
walks outward looking for a container whose siblings hold the same controls —
and on a normally-built form the *first* such level is the question row, since
every row holds one input and therefore looks like a twin of the next. Three
sub-questions inside a single entry were reported as entries 1, 2 and 3 of
nothing. Found only because the fixture was built with realistic per-question
`<div>`s; an earlier flatter check passed happily.

The first fix — require two or more controls — was too narrow: it also excluded
a legitimate entry that asks only one question. **A delimiter is the real
discriminator** (2026-08-06). An entry opens with something that names it; a
question row opens with a `<label>` bound to its own control. Deciding that by
*association* rather than by reading the text is what keeps the heading ban
intact, and what makes it tag-agnostic — nothing has to know whether a given
insurer titles entries with `<legend>`, `<h4>` or a styled `<div>`.

**Steps and entries are otherwise structurally identical**, so the detector
also requires every twin to be **visible at once**. Entries sit on screen
together; a wizard shows one step at a time. Without that check, a form keeping
its steps in the DOM behind `display:none` has every step read as an entry and
every label pointlessly qualified.

**…and a GRID-LAYOUT QUESTION ROW is indistinguishable from an entry opener
(found 2026-08-15, unfixed).** The delimiter rule above is what makes rule 6's
own shape misfire. Rule 6 exists for the layout where the question sits in one
`<div>` and the control in the next one over; that means the row's first child
is a bare element holding text, which is not a control and not a label bound to
one — a delimiter, exactly. So the row reads as an entry, its twins are the
ordinary question rows beside it, and the labels come back qualified.

Reproduced in `tests/fixtures/wizard_like.html`: two grid rows come back as
`Date of admission (entry 2)` and `Date of discharge (entry 3)`. That much is
cosmetic. **The reach is not.** `_live_sources` refuses to treat any control
carrying an `instance` as demographic — one patient record cannot answer the
second entry — so on a page laid out *entirely* in grid rows the whole
demographic block is qualified and **none of it fills**. Probed directly on a
four-control grid block: `Patient's Full Name`, `NRIC / FIN`, `Contact No.` and
`Residential Address` came back as entries 1 to 4. That is the failure the
2026-08-09 demographics work was done to end, returning by a different route,
on the shape 36 of RoboForm's 39 controls use and that print-derived insurer
forms use freely.

Left unfixed on purpose: it is a change to a core heuristic, and both plausible
discriminators (require the delimiter to be non-empty *prose*? require the
twins to differ in control count? read the row's position?) trade one
false-positive class for another. **The ClaimEZ dump settles which shape
actually matters** — the same dump that settles the visibility question and the
`locate`/`enrich` disagreement. Do not close it by widening `hasDelimiter` in
passing.

**A demographic label has to match the alias table exactly, and the table is
narrower than it reads (2026-08-15).** `demographic_field_for_label` normalises
to letters and then strips only *patient* qualifiers, so the reach stops at the
alias list itself:

| resolves | does not |
|---|---|
| `Patient's Full Name` | `Patient's Full Name (as in NRIC)` |
| `NRIC / FIN` | `NRIC / FIN Number` |
| `Contact No.` | `Contact Number` |
| `Residential Address` | — |

The refusals are correct behaviour — the qualifier list is an allowlist so that
`Hospital name` and `Doctor's name` cannot resolve — but the near-misses above
are ordinary wordings, not adversarial ones, and each costs a field that then
comes back blank with nothing explaining why. `tests/fixtures/wizard_like.html`
uses the resolving column and documents the other one at the top; **do not
reword a step-1 label there without re-running
`demographic_field_for_label`.**

Widening the table is not the move until the ClaimEZ dump says what the real
labels are. Adding `number` or a parenthetical-stripper as a guess is how
`Employer name (as in records)` starts resolving to the patient's name, and a
demographic reaches the doctor **already green**.

**A sample note that only parses in one format is a demo that fails in front
of a doctor (2026-08-08).** The panel's "Use a sample note" strip carries the
values the design spec shows as found — `S8012345D`, `14/03/1978`,
`9123 4567`, `GHS-88213004`. Run through `parse_demographics` as originally
written, it produced **one field**, and the one it could not produce was `dob`,
which is required — so clicking the sample reached the details step and stopped
there. The design assumed a parser that read labels mid-line; the parser wanted
them anchored. Neither was wrong on its own, and nothing connected them until
somebody pressed the button.

Whenever the sample note changes, run it through the parser rather than reading
it: `parse_demographics(SAMPLE_NOTE)` in `backend/demographics.py`.

**What it actually yields today, so nobody reads the list above as a
promise: `nric`, `dob` and `address`, and nothing else.** That is correct and
deliberate. The sample deliberately writes two phone numbers
(`9123 4567 / 6123 4567`) and two policy variants (`GHS-88213004 or
GH-88213004`), so both fields hit the two-candidates refusal — the sample
demonstrates the refusals as much as the finds, and
`test_two_values_behind_one_label_yields_neither` asserts it. The name is never
guessed from anything and the doctor typed it at step 1. So the required pair
is satisfied and the flow completes; the four values named in the paragraph
above are what the *design spec* shows, not what the parser returns.

**Those two boxes are no longer blank-and-silent (2026-08-11).** They still do
not fill, and they still must not — but `ParsedDemographics.choices` now
carries the candidates that caused the refusal, and the panel renders them as
buttons under the field: *"2 found in the note — pick the patient's."* The
reason is that a blank box was the panel's answer to two different situations,
and only one of them justified it. "The note does not say" and "the note says
two things and I will not choose between them" looked identical, so a
deliberate refusal read as the product failing to look — which is exactly how
the owner read it when testing on RoboForm.

`address` was added on 2026-08-11 and is worth knowing about, because it was
absent for the wrong reason. The sample writes it bare on its own line
(`Blk 118 Bishan St 12 #07-21, S570118`), and the label-anywhere pass excluded
address on the grounds that it "has no shape" — which is true of a name and
was never true of an address ending in a postal code. `_classify_segment` had
been using `POSTAL_PATTERN` to identify an address inside a compound patient
line the whole time. `_sole_address` now applies the same rule to an address
on its own line, with the same two-candidates refusal the phone has, because a
note carries the clinic's address under the signature about as readily as its
phone number.

**It was never only a blank box.** Redaction pass 1 removes the address only
when the record carries one (`redaction.py:154`), and pass 2's patterns cover
NRIC, phone and email — there is no postal-code pattern. So an address the
parser missed was still in the text when it reached the model, caught only by
the pass-3 sweep, which is itself an API call. Anything else the parser
silently declines to find has the same property: check whether pass 2 covers
it before calling a miss cosmetic.

**Duplicate PDF field names across pages.** Names like `Policy No` and
`Company Name` repeat on pages 2 and 3 of the AIA form. When adding fields,
verify the page and rect, not just the name.

**A control that rejects a value empties itself instead of complaining.** The
HTML value sanitising algorithm runs on every assignment, and anything it does
not recognise becomes the **empty string** — no throw, no warning.
`<input type="date">` does this to anything that is not `yyyy-mm-dd`, which is
every date this pipeline produces; `type="number"` does it to text. Two
consequences, and neither is visible without reading the value back: the write
is reported *filled* while nothing landed, and if the doctor had already typed
something there, the write **cleared it**. `writeOrRestore` in `fill/apply.js`
is the general guard and `applyDate` the DD/MM/YYYY → ISO conversion. Do not
move the conversion upstream — DD/MM/YYYY is the one format the schemas, the
prompt, `_apply_date_format` and the review screen all agree on, and the
control is the only thing that wants something else. Found by reading, not by
running: no fixture in the repo uses a native date control, and RoboForm's test
page does not either.

**Three fill modes.** `fill_mode: "acroform"` writes into the PDF's own fields
(AIA GHS, GE GHS — official fillable PDFs). `fill_mode: "overlay"` stamps text
at coordinates onto flat CamScanner scans that have no fields at all
(Prudential, Henner, AIA Medical Report). Overlay boxes are **points from the
page top-left**, not PDF's bottom-left origin — the conversion happens once in
`overlay_fill._box_to_pdf_rect`. `fill_mode: "web"` is the extension's target:
no `pdf_path` and no `pdf_field_name`, because the control is located at fill
time by matching labels against the live page. `POST /forms/{id}/pdf` refuses a
web schema — there is no PDF to hand back.

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
