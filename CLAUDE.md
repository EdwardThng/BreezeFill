# BreezeFill — working notes for Claude

Chrome MV3 extension + FastAPI backend that maps doctor consultation notes to
Singapore insurance claim forms. Users are private-practice GPs filling forms
between patients — speed and correctness both matter, and **a wrong autofill is
worse than an empty field.**

---

# HARD RULES

**These are mandatory on every change. Do not violate them without asking
first.** This block and **Guardrails** further down are the parts that
constrain what you may do. The history and the reasoning behind them live in
`docs/decisions/` — see **Where the rest lives**.

## Hard invariants — never violate these without asking me first

- **Redaction runs in the BROWSER, before anything leaves the tab.** Passes 1
  and 2 are `extension/privacy/redact.js`, applied at send time in `onMap`; the
  token→value map never leaves the panel. The server redacts again on arrival
  as a backstop and throws its own map away. If a change touches the request
  path to the model, state explicitly in your summary how redaction is
  preserved.
  <!-- This invariant read "runs before anything leaves the BACKEND" until
  2026-08-17, and by then the code had said otherwise for some time: the
  extension parses and redacts locally and posts to /map-redacted, which
  receives no PatientRecord and has nowhere to put one. The old wording sent
  the reader looking for the guarantee in the wrong process. -->
- **Pass 3 IS an Anthropic call, so "nothing identifying reaches the model" is
  not the claim to make.** `llm_sweep` (`mapping.py`) sends the pass-1+pass-2
  redacted text to Anthropic to find what the patterns missed, and `/map` and
  `/map-redacted` both run it before mapping. The defensible claim is that the
  model **answering the form** never sees identifiers; the sweep is part of the
  redaction mechanism rather than downstream of it, and `privacy.html`
  discloses it. Do not write "identifiers never reach the Claude API" into
  marketing copy, the store listing, or this file.

  The sharp edge, and it is the reason this is a hard rule rather than a note:
  **the server's backstop is pass 2 only, and pass 2 cannot catch a name.** A
  name has no shape, pass 1 is the only pass that finds one, and pass 1 cannot
  run on the server because the identifiers were deliberately never sent. So a
  name the browser's pass 1 misses reaches Anthropic **in the sweep call**.
  `tests/fixtures/redaction_corpus.json` tags those cases `sweep_only` and
  `tests/test_redaction_corpus.py` skips them offline — a skipped case is the
  honest record of a gap, not a gap in the tests.
- **No PHI in logs, traces, error messages, or test fixtures.** Use synthetic
  data in tests. Never paste a real note into a fixture file.
- **Demographic fields are deterministic, not inferred.** Name, NRIC, DOB,
  policy number and similar are mapped by explicit rules. Do not route them
  through the model, and do not "improve" them by adding LLM fallback.
- **The backend is stateless across forms.** No server-side session state
  carrying data between forms. If you think you need it, stop and ask.

  **One exception exists, and its boundary is the part to defend: the form
  bank** (`backend/form_bank.py`, added 2026-08-18, the owner's call). It keeps
  BLANK insurer forms uploaded by doctors, and the schemas derived from them.
  No patient, no note, no claim, no demographic — a published document the
  insurer hands to anyone who asks, plus a description of where its boxes are.
  The rule worth defending was never "no bytes may persist"; it was that
  nothing about a patient survives the request that carried it in, and that is
  unchanged.

  `form_bank.intake_guard` is what holds the line: a PDF with values already in
  its fields is somebody's completed claim, and it is refused for banking
  outright. `tests/test_upload_route.py` asserts that such an upload reaches
  storage as zero files. Do not widen what the bank holds, and do not add a
  second store on the strength of this one — the argument here is about blank
  forms specifically, not about persistence being fine now.
- **Field assignment is a scored assignment problem with an ambiguity margin.**
  Every field is scored against every control; a field whose best control beats
  its runner-up by less than `TIE_MARGIN` is refused as ambiguous rather than
  guessed; strongest matches claim their control first, and a field whose
  control is already taken is refused rather than displacing it. Two guards
  then gate the whole plan: `MIN_MATCHED` and `MIN_MATCH_RATE`, both, never
  either. Do not replace this with per-field independent matching that ignores
  collisions, and do not drop the margin or either guard to raise the fill rate.
  <!-- The invariant as first written said "Hungarian algorithm". There is no
  Hungarian assignment in this repo and never has been: `locate()` in
  extension/fill/locate.js ranks fields by best score and assigns greedily in
  that order, with TIE_MARGIN and a taken-set. Corrected to describe the real
  mechanism, because a rule in this section that misnames the code sends the
  next reader looking for an implementation that does not exist. If global
  optimal assignment is actually wanted, that is a change to make deliberately,
  not a rule to assert. -->
- **MV3 constraints are real.** Service worker is non-persistent — no
  long-lived in-memory state, no remote code execution, no `eval`.
- **The extension never submits a form**, never overwrites an answer already in
  a control, and never clicks a page button. It fills in place and stops.
- **`chrome.storage` holds the licence key and NOTHING else.** The permission
  is requested as of 2026-08-17, and the exception is exactly one string: a
  doctor cannot retype a subscription key between every patient, and a key
  names a subscription rather than a patient. The rule that mattered is
  unchanged and is the one to defend — **no part of the consultation note, and
  no demographic, ever reaches disk.** `panel.js` has one writer
  (`saveLicence`) and `panel.test.js` asserts nothing else is ever written. If
  something new needs to survive a panel close, that is a conversation about
  whether the note-never-touches-disk guarantee still holds, not a second key.

## Layout

```
extension/            MV3 extension. No content_scripts, no host permissions
  panel/              The doctor's surface. Progressive steps; holds the claim
                      in memory only
  fill/locate.js      Scores schema fields against live controls; TIE_MARGIN,
                      MIN_MATCHED, MIN_MATCH_RATE all live here
  fill/apply.js       Writes values. Never overwrites, never submits
  learn/dump.js       Label resolution + scrubber. INJECTED AT RUNTIME — ships,
                      despite reading like a console tool
  privacy/parse.js    Paste -> demographics, IN THE TAB. The browser's copy of
                      demographics.py; what made local redaction possible
  privacy/redact.js   Passes 1 and 2, in the tab. The map stays here
  privacy/patterns.json  The shapes, read by BOTH languages. Edit once
  content/fill.js     The only code that touches the insurer's page
backend/
  main.py             Every route, all stateless. `/map-redacted` is the
                      extension's only mapping route and takes no
                      PatientRecord; `_review_rows` is the redact -> map ->
                      assemble middle the WEBSITE's PDF path still uses
  redaction.py        Three passes. Pass 1 needs the demographics FIRST — that
                      ordering is the privacy model. Pass 3 is an Anthropic
                      call; see the hard rules
  form_intake.py      Uploaded BLANK form -> FormSchema. Sends the form to the
                      model unredacted, which is safe only because it is blank
                      — probe_pdf is what checks that
  note_intake.py      Uploaded note PDF -> text. HANDLES PHI, unlike
                      form_intake beside it. Extracts and stops: no redaction,
                      no parse, no model
  vision_intake.py    Uploaded SCANNED form -> overlay FormSchema, by
                      rendering each page and asking the model where the boxes
                      are. The only path whose geometry rests on the model's
                      word — see /forms/{id}/proof
  form_bank.py        The one thing that persists. Blank forms + derived
                      schemas, keyed by the PDF's own hash
  demographics.py     Paste -> demographic fields, patterns only, never a model.
                      Also owns the label alias table both directions share
  mapping.py          Structured-output call, FormSchema/FormField, assembly
  schemas/*.json      The form bank
frontend/src/         Landing, Demo (talks to nothing), ClaimApp at #/app
```

## Commands

```bash
# Run backend (needs the key in THIS shell; without it POST /map returns 503)
export ANTHROPIC_API_KEY=...        # never via the `!` prefix: it is logged
.venv/bin/python -m uvicorn main:app --app-dir backend --port 8000

# Run tests — THREE suites, three runners. All three must pass.
.venv/bin/python -m pytest -q                 # backend
npm test                                      # extension (from repo root)
cd frontend && npm test                       # website

# Load extension: chrome://extensions -> Developer mode -> Load unpacked
# -> select extension/. Reload after every change; reopen the side panel, and
# reload the insurer tab too.
```

There is no typecheck or lint step configured — do not invent one. Node comes
from nvm and is invisible to non-interactive shells; see the toolchain note in
`docs/commands.md` for the `PATH` line that fixes it. The fuller command list,
including Vercel and the overlay calibration tools, is in that file too.

## How to work

**Verify before claiming done.** Never report something as working without
running it. "Done" means: relevant tests green, and for user-facing flows,
actually exercised end to end. If you skipped a step or a test failed, say so
plainly and show the output. Do not summarize a failure as a success.

**Tests first for anything in the mapping or redaction path.** Write the
failing test, watch it fail, then implement. When fixing a bug, reproduce it
with a failing test before touching the fix. Elsewhere (UI, glue code) use
judgment.

**Small diffs.** Change what I asked for and nothing else. No opportunistic
refactors, no renaming, no reformatting untouched files. If you spot something
worth fixing, mention it at the end instead of doing it.

**Ask before expanding scope.** New dependency, new service, new architectural
pattern, or a change touching more than ~3 files that I didn't anticipate:
propose it first with the tradeoff, and wait.

**Edit, don't recreate.** Prefer modifying existing files over creating new
ones. Don't create `foo_v2.py` alongside `foo.py`.

**When the request is ambiguous, ask one question.** One, not five — the most
load-bearing one. Guessing and building the wrong thing costs more than asking.

**Commit and push after every file change.** Not batched at the end — the owner
reviews as the work lands, so an unpushed change is invisible. Many small
commits is the intended outcome, and an intermediate commit that does not pass
is acceptable. See **Working style** at the end of this file.

## Known gotchas

*Append to this every time I correct you. One line each, what to do.*

- Use `git ls-files -z | xargs -0 grep` for repo-wide greps — design-doc
  filenames contain spaces and the plain form silently breaks on them.
- On a new machine run `git var GIT_AUTHOR_IDENT` before committing: Vercel
  refuses to build a commit whose author email is not a real GitHub account,
  and the CLI reports it only as `UNKNOWN`.
- Derive the node path (`export PATH="$HOME/.nvm/versions/node/$(ls ~/.nvm/versions/node | tail -1)/bin:$PATH"`)
  before any `npm` call — nvm loads for interactive shells only.
- After moving machines, delete and rebuild both `.venv` and every
  `node_modules` — npm installs platform-specific binaries and the failure
  reads as a broken build.
- Read a value back after writing it to a control; one that rejects a value
  empties itself silently and reports as filled.
- Build the Chrome Web Store zip from *inside* `extension/` — the
  `/download` zip nests under a folder and the store rejects it.
- Run a changed sample note through `parse_demographics` rather than reading
  it; the panel's sample is held to what the parser actually returns.
- Re-run `demographic_field_for_label` after rewording any demographic label —
  `Contact No.` resolves and `Contact Number` does not, and the miss is a
  silently blank box.
- Check `field.options` before `field.type` anywhere that branches on a
  field's shape — an option-answered question is often a checkbox.
- Assert the positive case alongside every refusal: a refusal is not evidence
  of a working rule, and both look identical to a test that only checks `None`.
- Take the Vercel DNS target from `vercel domains inspect`, not from memory or
  from this file — the anycast range moved off `76.76.21.21`.
- Leave `chrome.sidePanel.setPanelBehavior()` uncalled; it throws `No SW` from
  every lifecycle event and the default is already correct.
- Keep `redaction.py`'s patterns blunt and `demographics.py`'s strict — one
  blanks text, the other assigns a value to a field.
- Never say "identifiers never reach the Claude API" — pass 3 (`llm_sweep`) is
  itself a Claude call on the pass-1+2 output. Say the model that *answers the
  form* never sees them.
- Edit `extension/privacy/patterns.json`, never a regex in `redact.js` or
  `redaction.py` — both languages read that file, and a shape changed in one
  place only is a leak whose tests all still pass.
- Check which surface you are reasoning about before citing the privacy model:
  the extension redacts in the tab, the website's `#/app` still posts raw notes
  to `POST /map`.
- `frontend/src/styles.css` is the claim UI's and is **globally scoped**; it
  already collides with the landing on `.step` and `.pill`. Scope new landing
  rules under `.landing`, and set `display` explicitly rather than inheriting
  whatever the claim UI happens to declare.
- `.landing a { color: inherit }` is specificity 0,1,1 and outranks a bare
  `.btn-primary` — style buttons as `.landing .btn-primary` or the label
  silently takes the page's ink instead of the button's.
- Define a colour's `-rgb` channels in **every** theme block that uses
  `rgba(var(--x-rgb), …)`. A missing triple resolves to nothing and the rule
  vanishes with no error.
- `vite preview` serves a cached `index.html`; check the hashed filename in the
  `<link>` before concluding a CSS change did not apply.
- Never delete a CSS range between two comment markers without reading what is
  inside it — doing that to the Coverage block took the FAQ, Final CTA and
  Footer with it, and the `.closing` overrides masked the loss.
- Turn off the macOS screenshot floating thumbnail (`Cmd+Shift+5` → Options).
  Until it flies away the file exists only under
  `/var/folders/…/TemporaryItems/`, and dismissing it deletes rather than saves.
- Regenerate site assets with `scripts/make_logo_assets.py` rather than copying
  by hand; it now writes `frontend/public/` too.
- Never raise `MIN_EXTENSION_VERSION` above the version **published on the
  store**, which is not the version in `extension/manifest.json`. The existing
  test compares it to the manifest and so cannot catch this; doing it bricked
  every public install for a day.
- Read the store's published version from the listing before touching a version
  number — the repo can be ahead of it, and "the latest version" means opposite
  things depending on which one you mean.
- Check whether a class name is already taken before adding a CSS rule for it:
  `.get-steps` was the `#/get` funnel's own `<ol>`, and reusing it for a nested
  list silently removed the numbers.
- Grep the stylesheet's own token list before using a CSS variable — the panel
  has `--text`, `--btn-line` and `--muted-strong`, NOT `--ink` or `--bg-raise`,
  and an undefined var with no fallback drops the whole declaration silently.
- Read a PDF's widgets per PAGE, not from `get_fields()` alone: page 1 of both
  real fillable forms carries zero widgets (it is instructions), and
  `page["/Annots"]` is an `IndirectObject` that needs `.get_object()` before it
  has a length.
- `Path(".pdf").stem` is `".pdf"` — pathlib reads a leading dot as a dotfile
  rather than an extension, so the obvious `stem or fallback` lets it through.
- Do not add `python-multipart` for a file upload; base64 in a JSON body keeps
  the deployed function's dependency list where it is and matches every other
  route in `main.py`.
- Render form pages as JPEG, not PNG — a scan is a photograph and PNG is 6.5x
  the bytes for nothing a model can read.
- Never render above ~1568px on the long edge: Anthropic downsizes anything
  larger, so the extra pixels are billed and discarded.
- Check a model-supplied box by rendering it, not by reading the numbers. A
  y-flip looks perfectly plausible on any box near the middle of the page and
  is obvious the moment you stamp one near the top.
- A bare `<button>` is inline-block, and the panel's step sections centre their
  inline children — set `display: block` on any new text-style control there or
  it lands in the middle looking like a heading.
- Use a PDF that is NOT byte-identical to one in `forms/` when testing schema
  derivation; `CURATED_BY_PDF` recognises the repo's own copies and short-
  circuits the whole path.
- Count the MODEL CALLS a request makes before shipping it, and multiply by the
  slowest plausible call. One-per-page looked fine in tests that stub the model
  and 504'd in production on a three-page form.
- `vercel.json` sets `maxDuration` explicitly. It is not the platform default,
  so read it rather than assuming the 300s the docs quote.
- Check `GET /health` for `form_bank` before believing anything is cached. A
  store that was never created reads as `NullBank` and degrades silently, by
  design.
- A cache that still uploads the payload is not a fast cache. Hash client-side
  and ask first when the thing being avoided is proportional to the file.
- Check the store zip's contents, not its filename, before uploading: unzip it
  and grep for something you added or removed since. The version in the name
  says nothing about when it was built.
- Diff the live route list against README's API table after adding a route —
  `/checkout` and `/licence/claim` shipped undocumented and were only found by
  enumerating `app.routes`.
- Never let a cache become the only home for something a later request needs.
  If losing it 404s a doctor mid-claim, it is not a cache — give the client the
  copy and let the cache be an optimisation.

---

Product docs live in `README.md` (what it does, privacy model, how to add an
insurer form). **Read that first.** The rest of this file records decisions,
current state, and the traps — the things not derivable from the code.

Stack: FastAPI + pypdf backend, React/Vite website, a Chrome extension, and
Anthropic structured output. Repo `EdwardThng/BreezeFill` (private). Pilot user
is the owner's father, a Singapore GP.

**In one paragraph:** a doctor opens an insurer's claim form, clicks the
BreezeFill icon, and pastes the consultation into a side panel. The panel
identifies which form the page is, asks the backend to map the note onto that
form's fields, shows every proposed answer with its source for the doctor to
confirm, and writes the accepted ones into the insurer's own page. It never
submits. The website exists to hand out the extension and demonstrate it.

**Three names, and only one of them is dead.** The product was FormFill, then
ClaimFill, now **BreezeFill** (renamed 2026-08-04). The sweep covered display
names, JS globals, the message target and the download filename. Two things
said `claimfill` — the Fly app and the `DEFAULT_API_BASE` that pointed at it.
Both are gone as of 2026-08-05: Fly is destroyed and the default backend is
`https://api.breezefill.com` (2026-08-06 — see "the domain"). Nothing
user-facing carries an old name any more, and a check for one is cheap:
`git ls-files -z | xargs -0 grep -il claimfill`, which should name only this
file. **Use the `-z`/`-0` form** — the plain `git ls-files | xargs grep` written
here until 2026-08-08 breaks on the design docs, whose filenames contain
spaces, and reports a pile of "No such file or directory" instead of an answer.
The git remote was the last holdout and was repointed on 2026-08-06, GitHub
having silently redirected pushes until then. `FORMFILL_*`
environment variables also survive from the first name and have **not** been
swept; renaming them means touching every command in these docs plus anything
set on a host, so it is a deliberate not-yet rather than an oversight.

---


## Guardrails — do not relax these

- Demographics never reach the LLM. They are copied onto the form
  deterministically and double as the redaction dictionary. **This extends to
  finding them**: `extension/privacy/parse.js` splits the paste with patterns
  and no model, **in the doctor's tab**, because a model that split it would
  have read the name before the dictionary that redacts the name existed. Do
  not "improve" the parser by handing the block to Claude when a field comes
  back blank — a blank field is a doctor typing one line.

  `POST /parse` still exists and still takes a raw paste; the extension stopped
  calling it when parsing moved into the browser. It is reachable, so treat it
  as a live route rather than dead code — but do not point the panel back at
  it, because that request is the whole note one step before redaction has a
  dictionary to work with.
- **The server is stateless about PATIENTS. Every route.** The token→value map
  lives only for the duration of one request, and there is no claim store,
  session or id behind any endpoint. Do not add one — a shared store would be a
  database holding patient data, which this product says publicly it does not
  have, and it would restore the two-machine trap that `--ha=false` used to
  guard.

  This wording changed on 2026-08-18 and the change is narrow. The form bank
  persists blank insurer forms; it holds nothing about a patient, and the
  upload path is still stateless in the sense that matters — `/forms/upload`
  and `/forms/{id}/pdf` are separate requests that may land on different
  machines, and the second finds the form by reading the bank key back out of
  the form_id rather than by anything having been remembered. See the hard
  rule for the boundary.
- **Every question on the page gets attempted.** The bank may not gate a fill:
  the doctor has to submit that form regardless, so a schema miss must cost
  sharpness and never coverage. Do not reintroduce a state where the panel
  looks at a form and declines to map it.
- **A described control travels under the schema's wording, not the page's.**
  This is what keeps a fully-described page from sending page text to the
  model, and it is easy to undo by "simplifying" `locate.enrich` to keep the
  live label. Only questions nothing describes may carry their own labels out.
- **No route may write a schema to disk from a running claim.** The panel's
  draft-schema offer was removed on 2026-08-17 (see "The draft schema is gone"),
  so there is nothing left that *proposes* one either — but the rule that
  outlived it is the important half: a schema governs every later claim on that
  form and nothing ever re-reads it, so it is committed by a human who has read
  it or not at all. This was decided with the alternatives on the table
  (auto-PR, auto-write). Schemas now come from a learn-mode dump.
- **`chrome.storage` is for the licence key and nothing else** (since
  2026-08-17). Patient notes must not reach disk: the claim lives in the side
  panel's memory while the doctor has it open, and closing the panel discards
  it. One writer, one key, asserted. Any future need to
  remember something between events belongs in the panel, not the service
  worker — a worker that has to survive eviction has to persist.
- **The extension never submits.** It fills in place; the doctor clicks submit
  and signs. `apply.test.js` and `content/fill.test.js` both assert it.
- **Nothing fills without a click, including when the page changes by itself.**
  The `MutationObserver` added for wizard steps re-identifies the form and says
  the page moved; it must never call fill. Advancing a step is the doctor using
  the insurer's form, not asking BreezeFill for anything, and an observer that
  wrote on render would quietly put the review step after the writing.
  `panel.test.js` asserts no fill message is sent.
- **An ambiguous date is never written without a confirm click**, whatever
  status it carries. `extracted` means the notes stated it, not that they
  stated it unambiguously, and DD/MM versus MM/DD is not something a model or a
  regex can settle from the note. Do not "tidy" this back into
  `needs_review = status != "extracted"`, and do not let a bulk-confirm control
  reach one.
- **A value is converted to what the control accepts, never written hopefully.**
  `<input type="date">` holds `yyyy-mm-dd` and silently empties itself when
  given anything else, so the whole pipeline's DD/MM/YYYY had to be converted at
  the last moment (`applyDate`). `writeOrRestore` generalises it: read the value
  back, put back what was there if the control refused it, and report `skipped`.
  A control that sanitises away what it was given must never be reported filled
  — and must never be left emptier than it was found.
- **Only ask for what the product actually needs.** `REQUIRED_FIELDS` is
  `full-name` and `dob`, and each earns it: neither has a shape pass 2 can
  catch, so a missing one stays in the text sent to the model. NRIC, phone and
  policy number are shaped and caught anyway — wanted, not required.
  **`insurer` was on that list and should not have been**: `redaction.py` pass
  1 never reads it, so it plays no part in the privacy model and exists only
  because some forms have a box for it. Blocking a doctor over an insurer their
  form never asks about demands something the product does not need. Do not add
  a field to that list because a schema mentions it — the test is whether
  redaction needs it.
- **An answer already in a control is never overwritten** (2026-08-06). Every
  write in `applyOne` is gated by `hasExistingAnswer`. A filled control was
  filled by the doctor or by the insurer pre-populating the form, and writing
  over it replaces a human decision with a model's *after* the review step has
  passed. A lone checkbox is deliberately asymmetric — ticked is an answer,
  unticked is indistinguishable from unanswered — so an untouched box stays
  fillable and a ticked one is never cleared. This also inverted an older
  assertion: an empty string no longer clears an existing value, because that
  is the same clearance by another route.
- **A multi-select with nothing ticked is only fillable if it can say "none".**
  An explicit "none of the above" (or `nil`, `N/A`, `not applicable`, …) makes
  empty legible as unanswered. Without one, empty means either unanswered or
  "none of these apply" and nothing can separate them, so the question is left
  for the doctor. The synonym list is exact rather than fuzzy on purpose: a
  miss is safe (the group reads ambiguous), a false match invites a wrong tick.
  `"No known allergies"` is an answer, not a refusal of a list.
- **Never put the same option in two instances of one repeating question.** A
  hard rule in `applyPlan`, keyed on the shared option list rather than on
  `name` (which frameworks index or regenerate). Seeded from the page first, so
  an option the doctor picked by hand is occupied too.
- **BreezeFill never clicks "add another", or any other page button.** Creating
  an entry is the doctor using the insurer's form. The filler writes into the
  instances that already exist and no others — the same rule as never
  submitting.
- **Entry numbers come from DOM shape, never from the heading that names
  them.** The sub-header ("Comorbidity 1") is the obvious key and is exactly
  the surface `NEVER_A_LABEL` forbids: a heading is name-bearing, a name has no
  shape, and learn mode has no dictionary. `instanceIndexOf` reads tag names
  and control types only, and `dump.test.js` plants a name in a sub-heading to
  prove it never reaches a dump. Do not "improve" the qualifier by reading the
  heading text.
- **An off-list answer is `missing`, never the nearest option.** When a field
  declares `options`, case and whitespace are forgiven and nothing else. Do not
  add fuzzy matching to raise the fill rate — the value is a clinical statement
  the doctor signs, and a near-miss snapped across by string distance is
  indistinguishable in review from an answer the notes supported.
- **Offering candidates is not choosing between them** (2026-08-11).
  `ParsedDemographics.choices` exists so a refusal is *visible* rather than
  indistinguishable from a blank; it must never become a ranking. Nothing is
  pre-selected, nothing is written into a field on the doctor's behalf, and the
  list is in the order the note wrote it rather than in any order of
  preference. Picking one counts as a correction — it marks the field
  `touched`, so a re-parse neither overwrites it nor asks again. The moment
  something here sorts by "probably the mobile", the two-candidates refusal has
  been undone by the back door.
- **A field with no shape is never offered as a choice.** `full_name` and
  `insurer` have no slot in the panel at all, and `dob` is offered *only* from
  a region a label already said was a date of birth. A clinical note is nothing
  but dates, so a list of every date in it invites the doctor to pick a
  consultation date as a birth date — one click, indistinguishable from a
  correct answer on the form. `test_dates_in_prose_are_never_offered_as_a_date_of_birth`
  pins it.
- No patient data in logs or error messages. LLM failures return a generic
  `"LLM call failed"`.
- ~~**No real patient data until inference is confirmed in-region.**~~
  **Overridden by the owner 2026-08-06: real patient notes are in scope.** The
  product is past its testing phase and a note anonymised before pasting no
  longer contains what the form asks for, so the rule was blocking the product
  rather than protecting it. **Everything below about the region is unchanged
  and still true** — what changed is the decision about it, not the fact. The
  privacy policy now discloses the transfer instead of forbidding the data, and
  `docs/testing/test_notes.md` remains synthetic because repo fixtures still must be.

  Both calls run `claude-opus-5` on the first-party API, which is not SG-region.
  **`inference_geo` cannot solve this** — **re-verified against the live docs
  2026-08-06**: the supported values are exactly `"us"` and `"global"`, and
  `"global"` is documented as "may run in **any** available geography". There
  is no Singapore, APAC or `ap-southeast` value.

  Two things that make this sharper than it was written:

  - **Workspace geo — where data is stored *at rest*, and where endpoint
    processing happens — is US-only, and cannot be changed after a workspace is
    created.** So this is not only about where inference runs.
  - **`FORMFILL_INFERENCE_GEO` is unset, so nothing is sent, so requests take
    the workspace default.** Unset does not mean "nearest"; it means `global`.

  **The confusion worth naming, because it nearly got written into the privacy
  policy: `sin1` is real but it is the wrong hop.** `vercel.json` pins the
  function to Singapore, so the raw paste genuinely does not leave SG when it
  reaches the server. `_review_rows` then calls `api.anthropic.com`, and *that*
  is the hop that exits the region. "The deployment is in Singapore" and
  "inference is in Singapore" are different claims and only the first is true. It is wired up behind `FORMFILL_INFERENCE_GEO` (unset by
  default) for whenever more geos land. Real SG-region inference needs
  **Amazon Bedrock `ap-southeast-1`**, where the region comes from the endpoint
  rather than a parameter — that means the `AnthropicBedrockMantle` client and
  `anthropic.`-prefixed model ids. Synthetic or anonymised notes until then.
- The API key belongs in a Vercel environment variable, never in a repo file,
  and never pasted
  into a chat transcript (including via the `!` prefix, which is logged).
- Repo fixtures are synthetic only.
- A learn-mode dump is an LLM input. It may be shared only after it has been
  read — the guarantee is structure-only by construction, but the residual
  risks in `extension/README.md` are real. Never send the URL, a screenshot, or
  the raw DOM alongside it.

---

## Where the rest lives

This file used to hold all of it — 3,300 lines, loaded into every session.
It was split on 2026-11-11. What stayed is what constrains a change; what
moved is history and reasoning, and it is **not loaded automatically**, so
open the file when the row applies.

| Read | When |
|---|---|
| `docs/commands.md` | Before running anything beyond the three test suites |
| `docs/decisions/traps.md` | Before "fixing" something that looks wrong |
| `docs/decisions/decisions.md` | Before changing how a thing works — the reason it works that way is here |
| `docs/decisions/aia-form.md` | Before touching portal detection, the fill guard, or dropdown handling |
| `docs/decisions/next-steps.md` | When picking up new work |
| `docs/decisions/system-design-open.md` | Before adding storage, accounts or auth. Nothing here is decided |
| `docs/decisions/status-2026-08-18.md` | For versions, the store submission, and what shipped |
| `docs/decisions/first-runs.md` | When a demo or a first install fails |

A decision, trap or status change gets recorded in the matching file, not here.
This file changes only when a rule, the layout, a command or a gotcha does.

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
