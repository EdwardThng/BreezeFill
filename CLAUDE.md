# BreezeFill — working notes for Claude

Chrome MV3 extension + FastAPI backend that maps doctor consultation notes to
Singapore insurance claim forms. Users are private-practice GPs filling forms
between patients — speed and correctness both matter, and **a wrong autofill is
worse than an empty field.**

---

# HARD RULES

**These are mandatory on every change. Do not violate them without asking
first.** Everything below this block is context, history and reasoning; this
block is the part that constrains what you may do.

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
from nvm and is invisible to non-interactive shells; see the toolchain note far
below for the `PATH` line that fixes it. The fuller command list, including
Vercel and the overlay calibration tools, is in **Commands** near the end.

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

## Status as of 2026-08-18

**Three versions, and they are not the same number.** Confusing them is what
caused the live outage described below, so keep them apart:

| Where | Version | What it means |
|---|---|---|
| `extension/manifest.json` | **0.3.0** | What the repo builds. First build where identifiers never leave the tab |
| Chrome Web Store, published | **0.2.1** | What every real install is running. Published 2026-08-12 |
| `MIN_EXTENSION_VERSION` (`backend/main.py`) | **0.3.0** | The oldest build production will answer. Live now |

**THE LISTING IS PUBLIC AND CURRENTLY NON-FUNCTIONAL.** The floor is 0.3.0 and
the store serves 0.2.1, so `onMap` refuses on every store install with *"This
version of BreezeFill is out of date and will not send anything."* This has been
true since `64bb88f` deployed on 2026-08-16.

`test_the_shipped_extension_is_not_already_disowned` was written to prevent
exactly this and does not, because it compares the floor against **the repo's
manifest** (0.3.0 ≥ 0.3.0, green) when the version that matters is the one
Chrome is serving. The test cannot see the store. **A `PUBLISHED_EXTENSION_VERSION`
constant, updated when an upload goes live, is the fix and is not written yet.**

The chosen resolution is to **publish 0.3.0**, not to lower the floor — 0.2.1 is
the build that sends the patient's identifiers to the server and the floor was
raised to disown it. Until the review clears, `#/get` step 2 downloads the
current build from `/download` instead of linking the store; see the header of
`DOWNLOAD_URL` in `Landing.tsx`, and **revert it the day the review clears.**

**1,138 tests pass**: 566 backend (1 skipped, 1 xfailed), 467 extension, 105
website. The package to upload is `breezefill-store-v0.3.0.zip`, built and
verified 2026-08-17 — 22 files, 121 KB. **It predates the panel changes of
2026-08-18 and this is verified, not inferred** — unzipping it shows
`step-route` absent and `step-counter` still present, against a zip built
17 Aug 18:44 and a panel last changed 18 Aug 21:37. **Rebuild before uploading**;
`docs/chrome-web-store-submission.md` now opens with the same warning.

### What shipped on 2026-08-18 — the PDF half of the product

The owner's father and two other GPs said the work is a *mix*: some claims are
filled on the insurer's portal, some are PDFs that get printed and filled by
hand. The extension only ever addressed the first. In one day:

| | |
|---|---|
| `POST /forms/upload` | A blank insurer PDF in, a mappable schema out. AcroForm boxes where the PDF has them; **rendered pages read by the model where it does not** — five of the seven real insurer forms have no fields and no text layer |
| `POST /forms/known` | The same answer from a SHA-256, with no upload at all. 2-3ms, flat across file size |
| `POST /forms/{id}/proof` | The blank form with every box stamped with its own field id. The review step for geometry, and the only check a doctor can make on a scan |
| `POST /notes/extract` | A consultation note that arrived as a PDF, as text |
| The form bank | Blank forms + derived schemas, keyed by the PDF's own bytes. **Not provisioned — see below** |
| The website | Form picker gone; upload first, notes by kind (paste or several documents), both reversible |
| The panel | Asks portal-or-PDF before anything else; step counter removed |

**Four bugs found by running it, none of which any test could see**, and each is
written up where it belongs: a **504** (one model call per page, in series,
against a 120s `maxDuration`), an **`unknown form_id`** after a full claim was
typed in (the bank made load-bearing for correctness when it is a cache), the
**bank doing nothing at all** in production, and the **step-1 label** naming the
wrong thing. The pattern is worth naming: every one of them was at a boundary
the test suites stub out — the platform, the clock, the storage, the eye.

**FastAPI's interactive docs are public in production** (found 2026-08-19).
`https://api.breezefill.com/docs` returns 200, as do `/redoc` and
`/openapi.json`. No data is exposed — only the API's shape — but that shape now
includes `/checkout` and `/licence/claim`. Turning them off is one argument to
`FastAPI(...)`. Recorded rather than changed, because it is a decision about
what the API advertises and not obviously the wrong one for a product with a
store reviewer reading it.

**THE FORM BANK IS NOT PROVISIONED.** `vercel blob list-stores` returns nothing
and `BLOB_READ_WRITE_TOKEN` is unset, so `build_bank()` returns `NullBank` and
every upload re-derives at a model call per page. Nothing breaks — the client
carries the schema — but a doctor filling ten claims off one form pays for ten
reads of it. `GET /health` reports `form_bank` so this is visible. **Deliberately
left for the owner**: see the design discussion at the very bottom of this file
before creating anything, because the answer changed once accounts entered the
picture.

Two threads now run in parallel, and they are independent: **the store
submission** (below) and **charging for it** (see "Pricing, and the gate that
does not exist yet"). Neither blocks the other — the listing can be submitted
free, and it should be, because the review takes weeks.

**2026-08-15/16: the test form and the demo-video form became one file.**
`tests/fixtures/wizard_like.html` was reworked from two steps to three — a
demographic step, the step the panel's own sample note answers, and a step it
deliberately cannot — and `wizard_test_v1` was rewritten to match. It is now
what the website's demo video is shot against as well as what exercises steps,
entries and option questions. See "Wizard support" under Next steps for what it
covers and why the third step is meant to come back blank.

Building it turned up two things worth acting on, both recorded below in Traps:
**a grid-layout question row is indistinguishable from a repeating-entry
opener**, which on a print-derived insurer form would refuse every demographic
control; and **the demographic alias table is narrower than the wordings real
forms use** (`Contact No.` resolves, `Contact Number` does not). Neither was
fixed — both want deciding deliberately, and the second wants the ClaimEZ dump
before anyone guesses at what to widen it to.

### The store submission (the current thread of work)

| Step | State |
|---|---|
| Demographics filled on the live path | **Done 2026-08-09.** The functional gap that would have shown a reviewer an empty name box — see "What one path quietly broke" |
| `optional_host_permissions` dropped | **Done 2026-08-09.** Never requested anywhere; the biggest single lever on review speed |
| Privacy policy live and accurate | **Done.** `https://breezefill.com/privacy`, 200, `Last updated 9 August`, including the clause saying the third redaction pass is itself an AI call |
| NRIC shape given to the sweep | **Done 2026-08-09.** Pass 3 is told the nine-character form; pass 2's regex stays tighter on purpose |
| Version at `0.3.0` | **Bumped 2026-08-16** by `64bb88f`, for the build where identifiers stop leaving the tab. `0.2.1` is what is *published*; `0.3.0` is what is waiting to be uploaded. `0.2.0` was built and its upload failed repeatedly with the package verified clean every time, so **a version is consumed by an upload attempt even when the review rejects it** — if `0.3.0` is refused as taken, cut `0.3.1` in `extension/manifest.json`, the zip filename **and** `MIN_EXTENSION_VERSION` together |
| Upload zip built | **Rebuilt 2026-08-17 at `0.3.0`.** `breezefill-store-v0.3.0.zip`, 121 KB, 22 files, manifest at root, gitignored. Grew from 0.2.1's 78 KB / 13 files because `privacy/` ships now. Verified: no BOM on either JSON, every manifest- and runtime-referenced file present, four icons matching their declared sizes, `panel.html`'s references resolving, no test files, no README, no external URLs. `README.md` is now excluded — a `.crx` is a zip anyone who installs can read, and it has no runtime purpose. **Rebuild rather than reuse**; the command is in `docs/chrome-web-store-submission.md` |
| Phase A — developer account, `privacy@breezefill.com` | **Done by the owner 2026-08-10.** The mailbox is live and tested both directions (2026-08-11), as is `support@breezefill.com` (2026-08-12) |
| **Screenshots** | **Done 2026-08-11.** Four at exactly 1280×800 in `~/Documents/breezefill-store/`. Lead with the `3.45.53` one — it is the frame where the panel reports "4 of 7 found, 2 to choose" and offers both candidates, which is the product's argument in one image. Four traps met on the way; all four are in next steps item 1 |
| 128×128 store icon, 440×280 promo tile | **Done 2026-08-11.** Both generated by `scripts/make_logo_assets.py`. The promo tile is **required** to submit and was not in this table until it nearly blocked the upload |
| Listing copy, disclosures, justifications, test instructions | **Written in full: `docs/chrome-web-store-submission.md`.** Single purpose, a justification per permission, the remote-code answer, the data disclosures, reviewer test instructions, and what the zip is. **Disclose Website content** alongside PII and Health information — `/map-live` sends the page's question labels |
| The listing form | **In progress.** Name and short description come from the manifest and are locked once uploaded; the long description, category, assets and the Privacy tab are the parts still to fill |

Two things to hold onto while the review runs. **Production is part of the
submission**: the reviewer's test hits `api.breezefill.com`, every push to
`main` auto-deploys there, and a broken route during review reads as a broken
extension. And **a new upload restarts the review clock**, so batch changes
rather than shipping into the queue.

| Piece | State |
|---|---|
| Pipeline: redact → LLM map → doctor review → PDF fill | Working. **Stateless as of 2026-08-04** — `POST /map` then `POST /forms/{id}/pdf`, no claim id, nothing held between them |
| Extension UI | **Redesigned 2026-08-08** to `docs/design/breezefill-panel/`. Progressive: one step at a time (name → note → other notes → check details → review → fill), finished steps fold into a summary row that reopens them, only visibility moves so every input stays in the DOM. Design tokens, a grey "Use a sample note" strip, and a fill report split into success / detail / deferred / fill-these-yourself |
| One paste box → demographics | Working, **in the browser** (`extension/privacy/parse.js`) since redaction moved local. Patterns only, no model. `backend/demographics.py` is still the reference implementation behind `POST /parse` and still carries the 34 tests; the panel no longer calls it. Verified end to end on the pilot's own note format: all seven fields, and the clinic's phone number under the signature correctly not taken |
| Second paste box: "Other notes" | Working, 5 tests. A claim form asks for things a consultation note does not hold (admission reference, ward class, billing codes). Both boxes join into **one corpus** via `pastedText()` — same parse, same redaction. Nothing reads `#paste` alone |
| `POST /map` — mapping for the **website's** PDF path | Working, shares `_review_rows`. **Not the extension's route** — that is `/map-redacted`, which takes no `PatientRecord`. `/map`, `/map-live` and `/parse` all still accept an unredacted note, and `frontend/src/api.ts` calls `/map`, so `#/app` sends raw notes to the server. Client-side redaction is a property of the EXTENSION, not of the product |
| Logo and icons | **Done (2026-08-05).** One generated set in `assets/logo/`, named for where each file is used rather than by size; `scripts/make_logo_assets.py` rebuilds it from the master. The extension declares `icons` and `action.default_icon` at last — it shipped with none until now, so Chrome drew a puzzle piece where the doctor is told to click. 16px assets are framed tighter because the mark blurs at that size; `assets/logo/README.md` has the reasoning |
| One path: always map the page | **Built and green (2026-08-05).** The bank stopped gating: every fillable control becomes a question, a matching schema lends its `description` to the controls it describes, and a miss costs sharpness rather than the fill. `POST /map` is no longer used by the extension — `/map-live` carries both kinds of field. See "the bank is no longer a gate" |
| Wizard support (steps + options) | **Built 2026-08-04; first exercised 2026-08-06** against `tests/fixtures/wizard_like.html` and `wizard_test_v1`, the first schema to declare `step` and `options`. Re-measured 2026-08-15 on the three-step fixture: with one step in the DOM, whole-plan `locate` matches 8 of 20 and **refuses**, `locateSteps` matches 8 and fills — the failure the per-step guard was written for, reproduced again on the wider form. Still **never run on a real wizard**; the fixture is synthetic and modelled on a verbal description. See "The AIA form" |
| Repeating entries, checkbox/option handling | **Built 2026-08-06, fixture-tested only.** Entry grouping from DOM shape (`instanceIndexOf`), options-beat-type coercion, never-overwrite, none-of-the-above, no-duplicate-option. Every one of these was designed from a verbal account of ClaimEZ — see the warning at the top of "The AIA form". **Entry grouping has a known false positive as of 2026-08-15** — it reads a grid-layout question row as an entry; see the trap |
| Bank → fallback | Working in tests. The wizard problem below is now addressed — see "The AIA form" — form identified by fingerprint against every schema, and `POST /map-live` maps against the page's own labels when nothing fits. **The draft-schema third step was removed 2026-08-17**; schemas come from a learn-mode dump. Never run in a browser: RoboForm is in the bank, so it exercises the wrong branch |
| Single-machine assumption | **Gone.** The server is stateless as of 2026-08-04, so `--ha=false` is a cost preference and serverless is possible |
| Vercel **production** | **Live**, region `sin1`, plan **Pro since 2026-08-06**. Re-verified 2026-08-08 against `api.breezefill.com` with plain `curl`, no SSO wall: `/health` returns `{"status":"ok","forms_loaded":8}`, `/forms` answers, `/download/breezefill-extension.zip` returns 86 KB of `application/zip`, and **`POST /map` returns real review rows from a live model call**. An earlier row here said `/map` 503s on a Preview-scoped key; that was fixed on 2026-08-05 and the row was never updated |
| Vercel migration | **Done (2026-08-05).** Production is public; **previews are behind Deployment Protection**, so only `vercel curl` reaches them and the extension cannot. `DEFAULT_API_BASE` points at production |
| AIA GHS claim (24 fields) + Great Eastern GHS claim (15 fields) | Live, smoke-tested end to end with a real LLM call |
| Website: landing page + interactive demo | Working, 65 frontend tests. **Redesigned 2026-08-12** — see "The website redesign". `#/` is a light-themed marketing page with a pricing section, a scroll-driven fill, and slots for a hero screenshot and a demo video; `#/demo` walks one synthetic claim with no backend at all and **keeps the old dark theme**; `#/app` is the 3-step PDF claim UI — kept and working, because the five PDF forms have no other interface, though nothing links to it any more. **The video slot now has something to shoot against (2026-08-15)**: `tests/fixtures/wizard_like.html?demo=1`, served locally. The video itself is not made |
| CI | **Added 2026-08-12**: `.github/workflows/tests.yml` runs all three suites on every push and pull request, three parallel jobs on `ubuntu-latest`, markdown-only pushes skipped. **No secrets** — every suite is offline, which also keeps it runnable from a fork. It **reports, it does not gate**: `main` is production and Vercel still deploys every push regardless. Closing that is next steps item 3 |
| `GET /download/breezefill-extension.zip` | Working, 8 tests. Zipped from the source tree per request, so a download can never be older than the server serving it. `extension/` is now in the Docker image |
| Single-origin serving (FastAPI serves `frontend/dist`) | Working locally, verified |
| `ANTHROPIC_API_KEY` | **Set as a Vercel environment variable**, Preview and Production, and confirmed working — a live `POST /map` returns real review rows, which exercises the sweep too. Not set in any local shell, so local `uvicorn` still needs it exported, or `FORMFILL_DISABLE_SWEEP=1`. Changing it does not reach an already-deployed function; redeploy after |
| **Demoable?** | **Yes — no terminal, no key (unblocked 2026-08-08).** The DNS record landed: `api.breezefill.com` and `breezefill.com` both resolve to Vercel (`216.150.1.193`) and both answer. Load the extension, click the icon on an insurer's form, paste, Map, Fill. **Exception: the RoboForm test route still needs localhost**, because `roboform_test_v1` is `internal: true` and `FORMFILL_SHOW_INTERNAL` is deliberately unset in production — point Advanced → Backend URL at `http://localhost:8000` for that one. See "the demo failure" below for what broke the first attempt, all of which is now fixed and tested |

Note: a commit title is not evidence of a deploy — `ec7c09c` is named "full
deployment on fly.io" and only adds a static mount. Verify deploy state with
`vercel`, not commit titles.

**Hosting is Vercel, and only Vercel, as of 2026-08-05.** The Fly app was
destroyed and `fly.toml`, the `Dockerfile` and `.dockerignore` went with it.
The one thing worth carrying forward from that era is why the two-machine
problem stopped mattering: the claim store is gone, so no request depends on
reaching the same instance as the last one. That is what made serverless
possible at all, and it is a property to preserve rather than a Fly detail.

### Where things live

| Path | What it is |
|---|---|
| `backend/main.py` | Every route. All stateless. `/map-redacted` is the extension's (no `PatientRecord`, backstop-redacts, discards its map); `_review_rows` is the redact→map→assemble middle behind `/map` and the PDF path |
| `backend/redaction.py` | Three passes. Pass 1 is dictionary-based and needs the demographics **first** — this ordering is the privacy model. Pass 1 CANNOT run on `/map-redacted`: the identifiers were never sent, which is the point |
| `backend/demographics.py` | One pasted block → demographic fields, **patterns only, never a model**. The reference implementation; the panel runs `extension/privacy/parse.js` instead |
| `backend/mapping.py` | The structured-output call, `FormSchema`/`FormField`, claim assembly — **and `llm_sweep`, which is pass 3 and is an Anthropic call** |
| `extension/privacy/` | `parse.js` + `redact.js` + `patterns.json`. Where redaction actually happens now. `patterns.json` is read by the Python too — edit it once, never twice |
| `backend/schemas/*.json` | The form bank. `fill_mode` is `acroform`, `overlay` or `web` |
| `extension/panel/` | The doctor's surface. Holds the claim in memory; the only thing on disk is the licence key. Progressive — `STEPS` and `showStep()` move visibility only, never the values |
| `docs/design/breezefill-panel/` | The panel redesign: handoff, UI brief, logo mark, prototypes. Renamed from the working name it was authored under |
| `extension/learn/dump.js` | Label resolution + the scrubber. Used by both learn mode and the filler. Also groups radios/checkboxes into one question, and derives repeating-entry indices from DOM shape |
| `extension/fill/locate.js` | Joins schema fields to live controls by label. Also what identifies a form |
| `extension/fill/apply.js` | Writes values. Never overwrites an existing answer, never repeats an option within a repeating question, never submits |
| `extension/content/fill.js` | The only code that touches the insurer's page |
| `frontend/src/` | `Landing.tsx`, `Demo.tsx` (talks to nothing), `ClaimApp.tsx` at `#/app`, `privacy.html` in `public/` |
| `tests/fixtures/wizard_like.html` | **The test form and the demo-video form, one file** (reworked 2026-08-15). Three `<legend>`-named steps — demographics, the section the panel's sample note answers, the section it deliberately cannot — plus a repeating question with an "add another" button. The only thing exercising steps, entries, option questions, a **native `<input type="date">`**, a checkbox group with an explicit none-of-the-above, and grid-layout labels. `?demo=1` drops the dev strip. No test imports it; it is a browser fixture |
| `api/index.py`, `vercel.json` | Vercel migration, prepared but not deployed |

Three test suites, three runners: `pytest`, `npm test` (extension, from the
root), `cd frontend && npm test`. See Commands.

---

## What running it actually broke, and what fixed it

Everything below was found by loading the extension in Chrome and clicking
things. None of it was findable from the test suites, and that is the point
worth internalising: the test suites cover logic the extension owns, and every
single failure so far has been at a **boundary the tests stub out** — Chrome's
permission model, Chrome's side-panel lifecycle, DNS, and the CORS envelope
around an unhandled exception. Budget for browser time accordingly; do not read
a green suite as readiness.

| Symptom the doctor sees | Real cause | Fix |
|---|---|---|
| Extension absent from `chrome://extensions` | Nothing wrong with the code — manifest was valid, all 8 referenced files present, OneDrive files were real and not cloud placeholders, Chrome 150 was past the 114 floor. It was the load step | Developer mode → Load unpacked → select `extension/` |
| "BreezeFill has no access to this tab", on a page plainly in view | `setPanelBehavior({openPanelOnActionClick: true})` opens the panel but grants **no `activeTab`** — Chrome handles the click itself, so `action.onClicked` never fires, and a click that never reaches the extension is not an invocation | Take `action.onClicked` and call `sidePanel.open({tabId})` from inside it. That *is* the canonical `activeTab` trigger |
| `Error: No SW` in the worker console, every start | `chrome.sidePanel.setPanelBehavior()` throws from the worker's top level **and** from `onInstalled`. Moving it to another lifecycle event was tried and failed | Delete the call. `false` is already the default, so it could never have helped a clean install — it was pure liability |
| "Could not reach the backend" | `formfill-backend.fly.dev` returns NXDOMAIN — destroyed or renamed, not stopped. Confirmed against `example.com` returning 200 from the same shell | `DEFAULT_API_BASE` → `http://localhost:8000` until a deploy exists |
| "Failed to fetch" with no status code, on Map fields | A missing `ANTHROPIC_API_KEY` makes the SDK raise a plain **`TypeError`** ("Could not resolve authentication method"), not an `anthropic.APIError`, so it escaped both `except` clauses. Starlette's `ServerErrorMiddleware` sits **outside** `CORSMiddleware`, so the resulting 500 carried zero `Access-Control-*` headers and the browser could not even report the status | Broad `except Exception` in `_review_rows` → 503 when the key is absent, 502 otherwise. Log the exception **type only**; a message or traceback can quote clinical text |
| Values silently cleared from fields the doctor had typed into | `applyOne` treated an absent value as an empty one and wrote `""` over it — then reported it filled | Absent-vs-empty guard at the top of `applyOne`, plus three tests |
| Fill refused on a 39-field page | Read at the time as the schema-mismatch refusal working. **It was not.** See the row below — the page had no usable labels at all, so no schema could ever have matched it | `MIN_MATCHED = 3` alongside `MIN_MATCH_RATE` is still right and still needed — but it was not what refused here |
| **36 of RoboForm's 39 controls had an empty label**, and an empty label scores 0, so nothing could match on that page whatever the schema said | The dumper's last-resort rule read `el.previousElementSibling`, which is **nothing at all** on a grid layout: the question sits in one `<div>` and the control in the next one over. Print-derived insurer forms use this as freely as they use tables. Not visible from any test — the fixture used `<label for>` and tables throughout | Rule 6 in `rawLabelFor`: walk up two hops and read the *container's* previous sibling. Bounded hard — stops at the form or fieldset, never reads headings or paragraphs, never reads a node containing a control. All 39 now resolve |
| The 3 controls that *did* have labels had junk ones — a `<select>`'s "label" was the option list of the `<select>` beside it | Same rule 5, no check that the neighbour was a control. Worse than junk: option text bypasses `buildOptions`'s withholding rule, which exists precisely because option lists enumerate patients | `NEVER_A_LABEL` — controls, headings, prose, and anything over 200 chars |

### The demo failure (2026-08-03) — two symptoms, one cause

Reported as *"failed to fetch, and no specific form listed in the dropdown"*.
Both come from the same thing: **no backend was running.** Confirmed after the
fact — `curl http://localhost:8000/health` returned nothing at all.

The chain is worth writing down because the two symptoms look unrelated and
the useful message is destroyed before it can be read:

1. On open, `loadForms()` fetches `/forms`, throws, and its `catch` does two
   things: writes *"Could not reach the backend. Check the URL under
   Advanced."* into `#map-status`, and calls `showPicker("No forms loaded.")`,
   which reveals an **empty `<select>`**. That is the missing dropdown entry —
   not a form-detection bug.
2. `detectForm()` then returns immediately on `if (!state.forms.length)`, so no
   host matching is even attempted.
3. Clicking **Map fields** calls `setStatus(status, "Redacting and mapping…")`
   on that *same element*, **overwriting the one actionable message on screen**,
   and then fails with the browser's raw `TypeError: Failed to fetch`.

So the panel knew the right answer at load and then threw it away on the first
click. Two consequences to fix rather than document around:

- `onMap` should not clobber a standing connectivity error, and a bare
  "Failed to fetch" should be translated the way the HTTP statuses already are
  — a doctor cannot act on it, and neither could the owner mid-demo.
- With an empty `<select>`, `$("form-id").value` is `""`, so even a backend
  that came back mid-session would 404 until the panel is reopened.

**The lesson, and it is not a UI one:** the product currently cannot be shown
to anyone without a terminal running `uvicorn`. Redeploying is still next steps
item 1.

Both UI consequences above are now fixed and pinned by `panel.test.js`, which
did not exist before: a network `TypeError` maps to a fixed sentence, `onMap`
retries `loadForms` rather than posting a `""` form id, Map refuses when no
form is selected, and a failed parse reports itself in the details drawer so
two messages never compete for one status line. A third was found while
testing: an empty form list was reported as "could not reach the backend",
which sends someone to check the URL of a server that answered.

### The RoboForm route (2026-08-03) — a demo that needs no API key

`roboform_test_v1` is a `fill_mode: "web"` schema against RoboForm's public
39-field test page. Every field is `demographics.*`, so `map_fields` returns
early without an LLM call, and with `FORMFILL_DISABLE_SWEEP=1` the whole path
— paste, parse, map, review, fill — runs with **no `ANTHROPIC_API_KEY`**.
That matters beyond convenience: the key was the thing blocking a demo.

**Run in Chrome on 2026-08-03 and the fields filled.** Paste → parse → map →
review → fill, end to end, no API key. Everything before this date that said
"nothing has been successfully filled anywhere" is now out of date.

Dry-run against the real page markup in jsdom: 5 of 6 matched, rate 0.83,
`safeToFill` true, five values in the right controls. The sixth is deliberate
— three `<select>`s share the label "Date Of Birth", so the matcher calls it
ambiguous and fills none of them. A test schema that only demonstrated success
would not be worth having.

It is `internal: true`, so it needs `FORMFILL_SHOW_INTERNAL=1` to appear in the
picker. It is also the first schema to declare `hosts`, so it is the first
thing that exercises host auto-detection at all.

---

## The AIA form, and the three things it breaks

Described to the owner in a walkthrough on 2026-08-04. **Not yet seen by any
tool** — this is a verbal account of the real ClaimEZ form, and it is the best
information the project has about its actual target.

**Everything in this section is built, tested against a synthetic fixture, and
has still never met the form it was written for.** They are mechanism, not
configuration: each degrades to the old behaviour when the shape they look for
is absent. So the risk is not that they break what works — the suites cover
that — it is that the mechanism answers a differently-shaped problem than the
real ClaimEZ turns out to pose. **The dump remains next steps item 1 and is
what would confirm any of it.**

**Six mechanisms now rest on this one verbal account** (2026-08-06). Listed
here so that a dump contradicting any of them is understood to overrule the
description, not the other way round:

| Mechanism | The assumption it rests on |
|---|---|
| `locateSteps` per-step guard | One step in the DOM at a time |
| Step `MutationObserver` | The URL does not change between steps |
| `instanceIndexOf` entry grouping | Repeated entries are **siblings that either hold 2+ controls or open with a delimiter** — a delimiter being any element before the first control that is not a control and not a label bound to one, so `<legend>`, `<h4>` and a styled `<div>` all qualify |
| No-duplicate option rule | Every instance of a repeating dropdown offers the **same option list** |
| Never-overwrite | A filled control was filled by the doctor or the insurer, not by us |
| None-of-the-above | A multi-select with no "none" option cannot distinguish unanswered from "none apply" |

The third and fourth are the most fragile: both were designed from a
description of how the page *looks*, and both fail closed (detection returns
null, nothing groups, today's behaviour resumes) rather than filling wrongly.
**A single dump of one repeating question with two entries open settles every
row in that table.**

**The form:** five steps — verification, admission details, patient diagnosis,
requested fees, review. Questions are a mix of dropdowns, yes/no options and
free text. Autofill concerns **admission details and patient diagnosis**;
verification is done by the doctor first, and requested fees is billing.

**The URL does not change** as the doctor moves between steps. It changes only
on the final step, review.

### What that buys

`activeTab` and the injected content script are torn down by *navigation*, and
there is none until review. So one icon click covers steps 1 → 4. The
`optional_host_permissions` declared in `manifest.json` "for access that
survives a wizard step" turns out to be **unnecessary** — do not request it
without a new reason.

### What that breaks — problem 1: identification runs too early

`detectForm()` fingerprints the page when the panel opens. That is step 1,
verification. The AIA schema describes admission and diagnosis fields, **none
of which are in the DOM yet**, so the match rate is ~0, the bank check fails,
and the panel offers the schema-free fallback for a form it has a schema for.

**Built (2026-08-04), two parts.** A `MutationObserver` in `content/fill.js`
watches the page's *shape* — control types, labels and visibility, never a
value — and messages the panel when it settles into something different; the
panel re-runs `detectForm`. Visibility is in the fingerprint so both wizard
shapes are caught: one that mounts and unmounts steps, and one that keeps them
all in the DOM behind `display`. And identification now scores each schema **by
its best-fitting single step** rather than by its whole field list, which is
what lets a four-step schema be recognised from one rendered step at all.

Two things it deliberately does not do. It never fills — advancing a step is
the doctor using the insurer's form, not asking BreezeFill for anything, and an
observer that wrote on render would move the review step to after the writing.
And it never overrules a form the doctor picked by hand, because re-detection
now runs repeatedly and silently changing that between steps would change which
form is being filled with nobody being told.

`optional_host_permissions` is still **not** requested and still not needed —
the URL does not change between steps, so `activeTab` survives.

### What that breaks — problem 2: the fill guard refuses a partial step

`MIN_MATCH_RATE = 0.7` asks "does this page carry the fields this schema
describes". A plan spanning admission details *and* diagnosis has, on either
step, about half its fields present — 0.5, under the threshold — so
`safeToFill` is false and the filler writes **nothing**. On a wizard this guard
systematically answers "wrong page" about the right page.

**Built (2026-08-04): `locateSteps` in `fill/locate.js`.** `FormField.step`
carries which step a field belongs to, travels through `MappedField` and the
fill plan, and the matcher scores each step on its own. **Every** step that
clears the guard by itself is taken to be on screen, and their fields are then
located together in one pass — the per-step scoring decides which fields to
try, the single pass decides where each goes, so two steps cannot both claim
the same control.

Filling every qualifying step rather than only the best-scoring one matters for
a form that reveals two sections at once, and "best rate" is a bad winner
anyway: a one-field step that happens to match scores 1.0 and would beat a
twelve-field step with eleven matches.

`MIN_MATCH_RATE` and `MIN_MATCHED` are **unchanged**, and each step must clear
both alone. Do not "fix" anything here by lowering them. The guard's whole
purpose is that a partial fill is indistinguishable from a complete one to
someone reviewing quickly; making it lenient globally reintroduces that
everywhere to solve it in one place. `locate.test.js` pins this from both
sides: the whole-plan refusal that motivated the work, and a half-present step
that still refuses.

A schema declaring no steps is one group, which is `locate` called exactly as
before — asserted, not assumed.

Filling incrementally as the doctor advances is safe because `applyPlan` is
**already idempotent**, which was designed for exactly this.

### What that breaks — problem 3: dropdowns and yes/no answers

`applySelect` matches the model's answer against option text, then option
value, and **skips when neither matches** — safe, but silent. A model answering
"Ward B1" against an option reading "B1 (4-bedded)" fills nothing. A yes/no
radio group gets the same treatment when the model returns `true` rather than
`Yes`.

**Built (2026-08-04), via the second of the two routes below.**
`FormField.options` carries the permitted answers verbatim as the form words
them. The model is shown the list; `_coerce_answer` then downgrades an off-list
answer to `missing` exactly as it already handles a malformed one, and the
value that survives is **the form's own string**, so the browser's exact-match
lookup is guaranteed to find it. The review screen renders those options as a
dropdown, so a doctor correcting one picks something the control accepts rather
than retyping the wording that was just refused.

Matching forgives case and surrounding whitespace and **nothing else** — "Ward
B1" against "B1 (4-bedded)" is `missing`, not the nearest option. That will
read as a defect to whoever meets it; it is asserted with the reason attached.
Snapping a near-miss to the closest option is a guess at what the doctor is
about to sign, made by string distance, and it is invisible in review.

The route not taken, and why:

- Constrain the structured output with a per-field enum. **Careful:** this is
  the shape that blew the grammar limits (see Traps) — per-field properties are
  what `mapping.py` deliberately avoids. `test_options_never_reach_the_output_grammar`
  keeps it that way.
- ✅ Keep the flat array shape and validate after parsing. No grammar risk,
  same guarantee, consistent with how every other malformed answer is handled.

Separately: a skip is no longer silent anywhere. The fill report now carries
the *reason*, because "skipped" alone covered three situations needing three
different responses from the doctor — already correct, not on this page, and
the value would not go in. The last of those is a field they reviewed and
approved.

### All three are still gated on the same thing

The mechanisms exist; the **data they run on does not**. `step` and `options`
are schema fields nobody has filled in, because no schema describes the AIA
form and nothing has read one.

**A learn-mode dump from a live ClaimEZ page, one per step.** It would give the
real field labels, the real dropdown option text, and the `<legend>` text that
names each step — which is simultaneously the input to writing the AIA schema,
the evidence for the step-detection design, and the only way to know whether
the controls are native `<select>`s or custom widgets. Everything above is
otherwise designed against a verbal description.

**One design question was deliberately left open rather than guessed.**
`isFillable` in `locate.js` checks `disabled` and `readOnly` but **not
visibility**, so on a wizard that keeps every step in the DOM behind `display`,
every step scores as present and the filler would write into steps the doctor
cannot see. Whether that is wrong depends on a fact nobody has: whether ClaimEZ
mounts steps or hides them. It was left alone because the obvious fix — refuse
invisible controls — breaks the common `visibility: hidden` custom-checkbox
pattern, and choosing between two unverified failure modes from a verbal
description is how the wrong one gets locked in. The dump answers it in one
look. (The step *watcher* already handles both shapes; this is only about
whether a hidden step should be filled.)

---

## Decisions and why

**The domain: linked early, announced late (2026-08-06).** `breezefill.com` was
bought and pointed at the Vercel project. The site was *not* announced, and the
two halves of that are separate decisions with separate reasons.

*Why link before there is anything to show.* Not for marketing — for the
version pin in Traps. `DEFAULT_API_BASE` was
`https://breezefill-livid.vercel.app`, where `livid` is a suffix **Vercel**
generated: it lives in Vercel's namespace, survives only as long as that
project does, and changes if the project is renamed or recreated. Every install
bakes that string in and **no installed extension can be edited afterwards**.
So the window to move the default onto a name we own closes the moment the
first doctor installs anything, which makes this a before-distribution task
rather than a launch task. It is now `https://api.breezefill.com`.

`api.` rather than the apex, though both point at one project today: it leaves
the API free to move — another host, another region, Bedrock for SG-region
inference — without touching extensions already in browsers. The site itself
needed no change at all, being same-origin throughout (`api.ts` resolves
`API_BASE` to `""` in production, `DOWNLOAD_URL` is relative).

*Why not announce.* Written 2026-08-06, when three of four blockers stood.
**Two have since cleared** and the count is now one: the plan is Pro
(2026-08-06), and the privacy policy is live at `/privacy` (2026-08-08).
Inference is still not SG-region, but that stopped being an announce blocker
when the owner put real notes in scope on 2026-08-06 — the policy discloses the
transfer instead of forbidding the data.

**The one that remains is the install**, and it is the whole argument: "download
a zip, enable Developer Mode" is not something a GP will complete, so an
announced site cannot do its one job. That is why next steps 2b — the Chrome
Web Store listing — is the thing standing between here and announcing, and why
the owner chose on 2026-08-08 to submit before the product is otherwise
finished.

*How it is kept out of search, and why not the obvious way.* An
`X-Robots-Tag: noindex, nofollow` header on `/(.*)` in `vercel.json`.
Deliberately **not** `Disallow: /` in `robots.txt`: `Disallow` blocks
*crawling*, not *indexing*, so a blocked URL that anything links to can still
surface as a bare link — and blocking is precisely what stops a crawler from
fetching the page and reading the noindex. The two fight and `Disallow` wins by
making the stronger instruction unreachable. `frontend/public/robots.txt`
therefore allows crawling on purpose and says why.

**To announce: delete the `headers` block from `vercel.json` and redeploy.**
Nothing else changes. `robots.txt` stays as it is.

*State as of 2026-08-08 — **DNS is live**.* Both `breezefill.com` and
`api.breezefill.com` resolve to Vercel (`216.150.1.193` / `216.150.16.193`) and
both answer: `/health`, `/forms`, `/privacy`, the extension download and
`POST /map` were all exercised over plain `curl`. The extension's default
backend now points at a host that exists, which is what unblocked the
"Demoable?" row.

Note for anyone re-checking the records: the address above is **not**
`76.76.21.21`, which is what the older Vercel docs and the previous version of
this paragraph name. Vercel's anycast range moved. Take the target from
`vercel domains inspect breezefill.com --scope breeze-fill` rather than from
memory or from this file.

*A correction to the reasoning above, worth keeping because it was nearly
recorded wrong.* `breezefill-livid.vercel.app` did **not** rot when the project
moved onto the team — `vercel alias ls` shows it and
`breezefill-breeze-fill.vercel.app` resolving to the *same* deployment. One
project simply carries several generated aliases. That weakens the "the URL
changes under you" story and leaves the real argument standing on its own: the
name is in **Vercel's** namespace, so it is theirs to change, and an installed
extension cannot be edited when they do. Do not restate the domain rationale as
"the old URL broke". It did not.

**A privacy policy exists as of 2026-08-06**: `frontend/public/privacy.html`,
served at `/privacy` (`cleanUrls` in `vercel.json` drops the extension, and
the old `/privacy.html` redirects rather than breaking), linked from the
landing footer. Static HTML rather
than a `#/` route on purpose — it is the document a Chrome Web Store reviewer
and a regulator have to be able to read, so it must not depend on the React
bundle rendering. **Live and serving 200 as of 2026-08-08**, once DNS landed.

One thing in it is a claim about the world rather than about this repo, and it
was untrue for a while: the contact address `privacy@breezefill.com`. **The
mailbox is live as of 2026-08-11** — the owner tested it in both directions,
sending and receiving. It had none when the policy went up on 2026-08-06, which
made the policy's own contact line unreachable and blocked the store listing;
this paragraph said so until today.

Keep it monitored rather than merely existing. **Google emails a Chrome Web
Store review decision to the developer account**, so a rejection nobody reads
stalls the submission indefinitely while it looks like it is still queued.

An earlier version of this paragraph said the policy carried a "synthetic notes
only" restriction. **It does not, and must not** — it was rewritten after the
owner's 2026-08-06 override, and now carries a *Real consultation notes*
section saying plainly that there is no test mode and no expectation that the
doctor anonymises anything first. What the policy does instead of forbidding the
data is **disclose the transfer**: a section stating that de-identified clinical
text leaves Singapore, that the PDPA expects a comparable-protection agreement
for an overseas transfer, and that **no such agreement is currently in place**.
Do not soften that paragraph. It is the one that makes the rest of the document
credible, and it is also the one a store reviewer will weigh against the data
disclosures.

`vercel.json` carries no `comment` key next to that block, though it wants one:
an unknown property risks `Invalid vercel.json`, and a config that fails to
parse is a deploy failure this repo has already paid for once (see the BOM
trap).


**The website's claim flow was restructured around the upload (2026-08-18, the
owner's call, same day as the upload path itself).** Three changes and one
consequence:

- **The form picker is gone.** Section 1 is the blank form itself. A doctor
  holding a claim form does not know or care whether this repo has a schema for
  it, and asking them to find their insurer in a list of six is a question the
  file answers. **`CURATED_BY_PDF` in `main.py` is what makes that safe**: an
  upload is hashed against the hand-authored forms' own PDFs first, so sending
  in `aia_ghs_claim.pdf` returns the 24-field curated schema rather than 98
  boxes derived from scratch, and the three overlay forms keep their measured
  geometry instead of having it guessed. It costs no model call and is not
  re-banked. Consequence: **every test about DERIVING a schema must use a PDF
  that is not byte-identical to the repo's** — `not_curated()` in
  `tests/test_upload_route.py` appends a comment after `%%EOF`, which is also
  the realistic case, since a form re-saved by a mail client differs.
- **The notes are asked for by kind**, paste or documents, rather than a paste
  box with a file input tucked underneath. Two normal situations, not a main
  path and a fallback.
- **Several documents, not one.** A discharge summary, an operation record and
  a referral are one consultation's worth of evidence. One unreadable scan
  names itself and the rest still go through.

**The step counter is gone from the panel (2026-08-18, the owner's call).** It
read "Step 1 of 4" in the header's top right. The panel already shows where you
are — each finished step collapses into a one-line summary that reopens it, so
the position is on screen as structure rather than as a number — and the
counter was the one piece of chrome the fork could not be numbered into without
making the work that matters read "Step 2 of 5". `updateProgress()` went with
it: with nothing to write to, it was a function that did nothing, called twice.

Both choices are reversible, and **neither back button discards anything** —
the notes box is the same box in both modes. That is why they are styled quiet
rather than as warnings. The panel has one too, on step 1 only: past there a
name and a note have been entered, and a control that throws those away to
re-ask an answered question is a trap rather than a way out.

The consequence: **`ClaimApp` no longer fetches `/forms` at all**, so a
connectivity failure surfaces on the upload the doctor actually tried rather
than as a banner about a list they never saw. `GET /forms` still exists and
still filters `internal`, but nothing in the website calls it.

**Filenames are never inserted into the note text.** It is tempting to label
each attachment in the box, and a filename like `TanWeiMing_discharge.pdf`
carries exactly the thing pass 2 cannot catch. The names are listed in the UI
and kept out of what gets mapped.

**Doctors get PDFs as well as portals, so the website takes uploads now
(2026-08-18).** The owner's call, from his father and two other GPs: the work
is a *mix* — some claims are filled on the insurer's portal, some are PDFs that
get printed and filled by hand. The extension only ever addressed the first.

**Most of the second was already built and unadvertised.** `#/app` has done
pick-a-form → paste → *editable review* → download-filled-PDF since the claim
store was removed. So the ask — "a way for doctors to edit the outputted filled
PDF, because not all fields may be filled or some fields may be filled not
super accurately" — was already answered, and answered better than asked:
**the values are corrected BEFORE the PDF exists**, not after. That is a plain
HTML form instead of an in-browser PDF editor, and a wrong value never gets
rendered at all. Do not replace it with PDF editing.

What was genuinely missing was the two uploads, and they are now:

- `POST /forms/upload` — a blank insurer form the bank has never seen, read
  into a `FormSchema` by `form_intake.derive_schema`. This is the same move
  `_live_schema` makes for a web page, with a PDF as the source instead of the
  DOM, so nothing downstream can tell the difference.
- `POST /notes/extract` — a note that arrived as a PDF, as text.

**The split that decides everything here, measured rather than guessed.** Of
the seven real insurer PDFs in `forms/`:

| | AcroForm fields | Text layer |
|---|---|---|
| `aia_ghs_claim.pdf` | 98 | yes |
| `ge_ghs_claim.pdf` | 143 | yes |
| the five in `scans_unsupported/` | **0** | **0** |

Five of seven are pure images — nothing to enumerate and nothing to read. Those
are precisely the ones that get printed and filled by hand, because that is
*why* they get printed. They are **refused, with the reason and a next action**
("check the insurer's website for a fillable version, which usually exists"),
rather than half-mapped. `SCANNED_REFUSAL` in `form_intake.py`.

**A raw AcroForm field name is not a label, and often is not anything.** Great
Eastern's own form has `undefined_2`, `undefined_3`, and `Day`/`Month`/`Year`
repeated across four different questions — 143 raw boxes where the hand-written
schema has 15. What each box is for is printed *on the page beside it*, so
`read_widgets` pairs every widget with the nearest text runs (same line to the
left first, then the line above) and the model is given that plus the page's
full text. Expect a messier review screen than the authored schemas produce;
this reads a form nobody has curated.

**The bank keeps what it derives** — the owner's call, and the reason is that
the expensive step is per-FORM, not per-claim. Deriving costs a model call per
page and the answer is identical for every doctor who ever uploads that same
PDF. Keyed by a hash of the PDF's own bytes, so a renamed file is the same form
and a different insurer's form with the same filename is not. See the hard rule
for why this does not breach the statelessness invariant, and `intake_guard`
for the check that keeps it from doing so.

**The insurer is typed by the doctor, never inferred from the filename.** It
reaches the form as a demographic — copied deterministically, skipping both the
model and the review confirm — so a guess there is a wrong value nothing
downstream checks. Same reasoning as the rejected "scan the note for insurer
names" in next steps item 9.

**An attached note is APPENDED to whatever was pasted, never substituted.** A
doctor who pasted a consultation and then attached an operation record meant to
send both, and losing the first is unrecoverable from that screen.

**The extracted note text is shown in the box rather than sent onward.** A
PDF's text layer is not always what the page looks like: columns interleave,
footers repeat, a letter carries the clinic's address. What sits in that box is
what redaction searches through — the same reasoning that keeps the parsed
demographics on screen and editable.

**And the panel now asks which kind of form this is, before anything else**
(the owner's first framing of this whole thread). A fork, not a step: the
portal answer reveals step 1, the PDF answer opens `breezefill.com/#/app` in a
new tab and leaves the panel where it is. `chrome.tabs.create` needs no
permission — `tabs` gates READING a tab's url and title, which this panel
deliberately cannot do. The answer is **not remembered**; `chrome.storage` is
the licence key and nothing else, and a doctor who does portals on Monday and
PDFs on Tuesday is the ordinary case.

**The vision path — built 2026-08-18, and it is what covers the majority of
real forms.** A scanned blank form is rendered page by page, the model is asked
to locate every box on the page, and what comes back becomes a `FieldBox`.
`overlay_fill` needed no change at all: its coordinates were already measured
from the page's **top-left**, which its own docstring explains is because
bottom-left "is miserable to calibrate against a rendered image". Top-left is
how an image is addressed, so the conversion is a multiply with **no flip** —
verified by eye on `henner_prior_agreement.pdf`, with boxes at y = 0.03, 0.25,
0.75 and 0.95 landing at the top, a quarter down, three quarters down and the
bottom.

`backend/vision_intake.py`. Renders at a long edge of 1500px, because Anthropic
resizes anything above ~1568px and larger is tokens spent on discarded pixels.
**JPEG, not PNG** — these pages are photographs of paper and the lossless copy
is 6.5x bigger (1087 KB against 168 KB) for no legibility a model can use.
`MAX_VISION_PAGES = 12` is a cost guard, since every page is a separate call
carrying an image.

**The risk this path has and the AcroForm one does not, and what is done about
it.** A fillable PDF states where its boxes are. Here a model says, and a model
reads a form well and localises only approximately. A box 15pt high stamps the
answer onto the ruled line above, and **the review screen renders that exactly
like a correct answer** — which is the whole problem, because review is where
every other error on this product gets caught.

Two layers, and the second is the one that matters:

- `_to_box` refuses what is obviously impossible: off-page, inside-out, NaN or
  infinity, a box over `MAX_BOX_AREA` of the page (a section, not a field), a
  box too small to write in. A box running a hair past the edge is **clamped**,
  not refused — a field at the page margin is ordinary.
- **`POST /forms/{id}/proof` is the review step for geometry**, and it exists
  because the refusals above cannot catch a box that is merely slightly wrong.
  It returns the doctor's own form with every box stamped with its own field
  id — the same trick `scripts/calibrate_overlay.py --proof` uses on the three
  hand-calibrated forms, and it needed no new fill mode because **the ids are
  the values**. A doctor cannot audit a JSON schema; they can see that
  `date_of_admission` is sitting on the wrong line. The website offers it for
  `fill_mode: "overlay"` only, and opens it in a tab rather than downloading it
  — a proof sheet in Downloads beside the real filled forms is a way to print
  and sign the wrong file.

**A 504 on the first real upload (2026-08-18), and it was a wall-clock bug
rather than a broken one.** A doctor uploaded a blank Great Eastern form that
was not in the bank and got a gateway timeout after the read had finished.

Two things compounded, and neither was visible from any test:

- `vercel.json` capped the function at **`maxDuration: 120`** — not the 300s
  the platform allows.
- **Both derive paths ran one model call per page, in series.** GE's GHS claim
  is three pages of 61, 58 and 24 boxes, each call emitting a line per box, so
  page 2 alone is ~4,000 output tokens. Three of those back to back is minutes.

The pages are independent — that is *why* it is one call per page — so the
series was wall clock spent for nothing. `read_pages_in_parallel` in
`form_intake.py` now runs them together, capped at `MAX_CONCURRENT_PAGES = 4`
so a twelve-page form meets a rate limit instead of a timeout. Measured 3x on a
three-page form. `maxDuration` is 300 for headroom.

Two properties the tests now pin, because both are invisible until they bite:
**a page that raises is skipped rather than fatal** (the docstring claimed this
and only delivered it for model-level refusals — an exception lost the whole
form), and **field order does not depend on which page finishes first**. The
second one matters more than it looks: ids are slugged with a collision
counter, so a form read in a different order each run would attach `date_2` to
a different box every time, and a banked schema would then disagree with the
form it came from.

`test_every_page_is_in_flight_before_any_of_them_finishes` uses a
`threading.Barrier` sized to the page count, so a serial implementation blocks
and fails. Verified by forcing `MAX_CONCURRENT_PAGES = 1` and watching it go
red — a concurrency test that has never been seen to fail is not evidence.

**The lever not pulled: `FORMFILL_DERIVE_MODEL` and `FORMFILL_VISION_MODEL`.**
Both default to `claude-opus-5`, and a cheaper model would roughly halve this
again. Left on Opus deliberately — naming a box wrongly puts a value in the
wrong box on a form a doctor signs, which is the same class of error the whole
product is arranged against. Change it if cost bites, not for speed.

**`unknown form_id: upload_9868ee…` — the bank had been made load-bearing for
CORRECTNESS (2026-08-18).** A doctor uploaded a form, watched it scan, pasted
the notes, filled in the patient, and got a 404 from `/map`. The server had
derived that schema, handed back an id for it, and thrown it away.

The unprovisioned store below is what triggered it, and it was **not the bug**.
The bug is that the bank is a SPEED CACHE and had been wired as the only place
an uploaded schema lived, so a Blob outage, an eviction, or a store nobody
created all produce the same 404 in the middle of a claim — after the doctor
has typed everything in.

**The client carries what the server did not keep.** `/forms/upload` returns
the whole schema alongside the summary; `/map` and `/forms/{id}/pdf` accept it
back, plus the blank PDF itself for the fill. This is the same shape
`/map-redacted` has always used, where the browser sends the page's fields and
the server builds a schema for one request. The bank is now purely an
optimisation, which is what it should have been.

Four rules that keep it safe, all asserted:

- **A carried schema is honoured for an `upload_*` id only.** What
  `aia_ghs_claim` means is decided in this repository, not by a caller.
- **A carried PDF must hash to the key in the form_id.** The key IS the content
  hash, so this is checkable — and without it a caller could pair one form's
  boxes with another form's pages, which on an overlay form stamps answers at
  coordinates measured on a different document.
- **A curated form carries nothing back.** Every deployment has it; shipping a
  schema and a multi-megabyte PDF for it is bytes for nothing.
- **The 404 that remains says what to do** ("send it again"), because the
  caller can fix it and the old message could not be acted on.

Verified end to end over HTTP against a `NullBank` server: the old request
404s, the carried one returns a real filled PDF, and a mismatched PDF is
refused 422.

**The bank was doing nothing in production, and its failure mode is silent by
design (found 2026-08-18).** `vercel blob list-stores` returned *No blob
stores found* and `BLOB_READ_WRITE_TOKEN` was not set, so `build_bank()`
returned `NullBank`: every upload re-derived from scratch, at a model call per
page, and nothing was ever kept. The first real scan a doctor sent in was not
banked.

That is the bank working as specified — it fails open so a storage outage
cannot stop a doctor working — which is exactly why an unprovisioned store is
indistinguishable from a working one from outside. **`GET /health` now reports
`form_bank` as the class name in use.** A name is not a credential, and
`"NullBank"` is the whole diagnosis.

**To turn it on** (owner's terminal — it creates a billable store):
`vercel blob create-store breezefill-form-bank`, then confirm
`BLOB_READ_WRITE_TOKEN` appears in `vercel env ls production`, then redeploy.
Until that is done, everything below about caching is inert.

**A second upload of a known form no longer sends the PDF at all
(2026-08-18).** Caching the schema made the second read cheap; it did not make
it *fast*, because the doctor was still uploading two or three megabytes and
waiting on a round trip proportional to it, to be told something a
32-character string settles.

`POST /forms/known` takes a SHA-256 and returns the schema or a 404. The
browser hashes the file with `crypto.subtle` and asks first; the bytes travel
only on a miss. Measured **2-3ms server-side, and flat across file size** —
0.4 MB and 3.0 MB answer identically, because neither is sent.

Three things to keep true:

- **The hashes must agree across the two languages.** `form_bank.key_for` is
  `sha256(bytes).hexdigest()[:32]`; the browser computes the full digest and
  the server truncates. Verified by computing both on `ge_ghs_claim.pdf` and
  comparing. Change one without the other and every hit silently becomes a
  miss — no error, just the slow path forever.
- **The ask is an optimisation and must never fail the request.** A 404, a
  network fault, anything: `uploadForm` falls through to the real upload. An
  optimisation that can break the thing it optimises is a liability.
- **`/forms/known` and `/forms/upload` must not drift.** A doctor who took the
  fast path has to get the same schema, or the fill disagrees with the review.
  `test_the_answer_matches_what_uploading_would_have_returned` compares them
  field for field.

The full upload route short-circuits on the hash too, before `probe_pdf` runs
— parsing a PDF the server can already describe is work with no answer in it.

**PyMuPDF is a runtime dependency now**, in both requirements files. It was
calibration-only and deliberately excluded until today. `vision_available()`
checks for it rather than assuming, and `refusal_for(probe, can_render=False)`
**defaults to refusing** — a wrong refusal costs a doctor a form, a wrong
acceptance costs them a stamped-on page they cannot see is wrong.

**What is NOT verified, and cannot be from here: whether the model actually
locates boxes well on a real insurer form.** Every test on this path feeds a
stubbed vision client, so what is proven is the plumbing, the refusals and the
coordinate conversion — not the accuracy. The first real run wants a person
looking at a proof sheet for one of the five forms in `scans_unsupported/`, and
that is the thing to do before this is offered to anyone.

Two other things to keep in view. The filled overlay PDF is returned through
the function, and `prudential_accident_hosp.pdf` is 2.82 MB before filling
against **Vercel's 4.5 MB response cap** — the limit with the least headroom in
the whole product. And a scanned form has no AcroForm fields, so
`probe_pdf().already_filled` proves less here than on a fillable PDF: a scan of
a form somebody already completed by hand cannot be detected, and would be
banked. The residual risk is stated in `derive_overlay_schema`.

**The draft schema is gone, and Advanced is the developer's (2026-08-17).** Two
removals from the panel, both the owner's call, and they share a reason: the
panel had two blocks whose audience was not the doctor sitting in front of it.

*The draft schema.* A successful fill on a page nothing described used to hand
back a proposed schema as JSON, for a human to read and commit into
`backend/schemas/`. The human was a GP. Asking a doctor to review JSON is asking
for something they have no reason to be able to do, and the argument that made
the draft safe to offer is the same one that makes it costless to delete: a
schema only ever makes answers *sharper*, never decides whether a question is
attempted, so a form with no schema fills exactly as it did before. `draftSchema`,
`showDraft`, `onCopyDraft`, `HOST_SUFFIXES` and `mappingLive` are all gone, along
with the `step-draft` section. **Schemas are authored from a learn-mode dump
instead**, which is the better input anyway: it reads the page rather than
inferring the form from one claim against it, it covers controls a sparse note
left blank, and it can be taken per wizard step.

What survives the removal is the rule underneath it — see the guardrail. No route
may write a schema to disk from a running claim, and the full-host trap
(`claimez.aia.com.sg` → not `com.sg`) now has to be applied by whoever writes
`hosts` by hand.

*Advanced.* The Backend URL override is a developer affordance that was visible
to every install. It is now `hidden` in the markup and revealed by `panel.js`
only when `update_url` is **absent** from `chrome.runtime.getManifest()`, which
is how Chrome distinguishes an unpacked install from a Web Store one. Three
things about that mechanism worth keeping:

- **It needs no permission.** The manifest answers it directly; `chrome.management`
  would have meant a new permission in the story a store reviewer reads, which is
  a bad trade for hiding a text box.
- **Hidden is the default, both in markup and on failure.** The `<details>` ships
  hidden and the check reveals it, so a panel whose script never ran does not
  flash it, and a `getManifest` that throws leaves it hidden.
- **It is a heuristic, not a security boundary.** Getting it wrong shows a doctor
  a text box — the behaviour that shipped until today. Anything that genuinely
  must not reach a doctor needs a real check.

`api-base` stays in the DOM either way, so only visibility moves and nothing
about which backend is called depends on the drawer being open. **Consequence to
accept:** on a Web Store install there is no way to point the panel at a local
backend, which matters for the RoboForm route (`FORMFILL_SHOW_INTERNAL`) and for
`wizard_test_v1` — both need a local server. Test those on the unpacked copy,
which is what a developer is running anyway.

**Pricing, and the gate that does not exist yet (2026-08-12).** The owner's
call: **SGD 200/month per clinic**, billed through Stripe on the website, with
the extension distributed free through the store during the pilot.

The decision that matters is not the price, it is **how a subscription gates
anything**. Today the extension calls `api.breezefill.com` with no
authentication at all: anyone who installs it uses it free, forever. A
subscribe button in front of an ungated product sells nothing.

Chosen shape: **a licence key the doctor pastes into the panel once, verified
by asking Stripe whether that subscription is active.** Stripe holds the
subscriber list, so the backend gains no database of its own — which matters
because `README.md` says publicly that there is none, and that sentence is
load-bearing for a product asking clinicians to trust it. What it costs: the
extension needs a new version and a second store review.

The alternatives, so they are not re-opened. *Full accounts* — sessions,
password reset, real user records sitting beside a product whose pitch is that
it stores nothing. *Ship the button and gate later* — fastest, but Chrome's
own terms say you **may not collect future charges from users for copies they
were allowed to download for free**, so every pilot install would be
permanently free. That clause is also why the paid tier must be built as an
upsell on top of a free baseline rather than a switch that turns the existing
product off.

Nothing is wired yet. `subscribeUrl()` reads `VITE_STRIPE_PAYMENT_LINK` at
build time, and while it is unset the pricing card says subscriptions are not
open rather than rendering a dead button — a control that looks live and does
nothing is worst on the one that takes money.

**The website redesign (2026-08-12).** The owner supplied a design export and
asked for it to be implemented. It was a **template for a different product** —
the assets in the zip are screenshots of "Bubble Lab", a community-ops tool,
and the BreezeFill copy was that template with nouns swapped. Three of its
claims were false here and were not implemented:

- *"Nothing leaves your browser."* The paste goes to the backend, which is
  where identifiers are found and the note is scrubbed. What is true, and is
  the stronger claim, is that the **model** never sees them.
- *"Free and open source."* Neither, and the same page quotes a price.
- *A save/remember prompt, "saved responses live in browser storage", iframes
  and open shadow DOM.* No `chrome.storage` permission exists, and iframes and
  shadow roots are open unknowns rather than shipped behaviour.

The visual language was taken and the claims rewritten; `Landing.test.tsx`
gained guards for each of the three, because a future redesign pass will
reintroduce them otherwise. What the design dropped and was kept anyway:
`#privacy` and `#faq`. On a page asking a doctor to send clinical text to a
server, deleting the honest disclosure is the worst available trade — and the
store listing points a reviewer straight at it.

Two things about the light theme worth knowing before touching it. **The
accent had to split**: `#3aa0dc` is the logo's blue and it works on a dark
ground, but on the light one it measures 2.76:1 as text and 2.90:1 under white
on a button, both failing AA. So the brand blue is a **fill** (logo, tints,
the hero glow, the pill on the dark band) and a darker `#1a6fb8` carries
anything that has to be read. And **`.landing` and `.demo` no longer share a
token block** — the demo was not redesigned and its stylesheet assumes a dark
ground, so re-merging them breaks `#/demo`.

**Hosting is being revisited (2026-08-04), and the statelessness above is what
unblocks it.** The original single-origin decision assumed the website *was*
the product; it is not any more, so the website (static: landing, demo,
pricing) and the API (Python, needs the key, needs a region) no longer have to
share a host. Two options are open, both now viable:

- **Website on Vercel, API on Fly.** *(Not taken; Fly is gone.)* Lowest risk at
  the time, and the wiring already
  exists — `VITE_API_URL` and `FORMFILL_ALLOWED_ORIGINS` were deliberately
  left in place. Buys: no cold start on the marketing site, and the download
  page stays up when the API is down (it went down with it for ten minutes on
  2026-08-03).
- **Everything on Vercel.** Possible only because the API is stateless now —
  serverless gives no sticky instance, so the old claim store would have 404'd
  every approve.

**Chosen 2026-08-04: everything on Vercel.** (Fly was kept as a fallback for a
day and destroyed on 2026-08-05 — a backend nobody redeploys is a stale build
with a health check, not a safety net.) Prepared
and committed, not yet deployed — it needs `vercel link`, `vercel env add
ANTHROPIC_API_KEY` and a preview deploy, all of which the owner must run.

The limits were checked against the live docs on the owner's **Hobby** plan,
and both earlier worries were out of date:

| | Hobby | Needed |
|---|---|---|
| Function max duration | **300s** default and max | 10–30s Opus call |
| Region | one, **and you choose it** | `sin1` |
| Python bundle | 500 MB | ~50 MB |
| Response body | **4.5 MB** | largest filled PDF 2.82 MB |

Two things to carry forward:

- **The 4.5 MB response cap is the one with the least headroom.** The PDF fill
  returns the file through the function. `prudential_accident_hosp.pdf` is
  2.82 MB before filling. A future insurer form that is a longer scan would
  413 on Vercel. There is no second host to fall back to any more, so check
  the size when adding an overlay form.
- ~~**Hobby forbids commercial use**~~ — **settled 2026-08-06: the plan is
  Pro.** Hobby counted "advertising the sale of a product or service" as
  commercial, donations included, so the planned pricing page put the project
  over the line on any hosting shape — the marketing site is what carries it.
  Pro ($20/month) removes the question rather than answering it, which is the
  point: the alternative was re-litigating "is this commercial yet" at every
  copy change. The 4.5 MB response cap above is unchanged by the upgrade and
  is still the limit with the least headroom.

Favourable detail worth knowing: Vercel bills *active CPU*, and "waiting for
I/O (e.g. calling AI models) does not count". This app spends nearly all its
wall-clock time blocked on Anthropic, so it consumes very little billable CPU.

A FastAPI app on Vercel becomes **one function receiving every path**, so there
are no rewrites in `vercel.json` and the routes work unchanged. Static comes
from `public/`, filled by the build command; hash routing is what makes that
enough, since only `/` has to resolve statically.

Below is the original reasoning, kept because it explains what single-origin
was protecting:

**One app on Fly, not Vercel + Fly.** The frontend is built into the image and
served by FastAPI, so there is one URL and one deploy. This removed the CORS
allowlist and `VITE_API_URL` from the critical path — two fewer things to
misconfigure during a pilot. `FORMFILL_ALLOWED_ORIGINS` still works and is
still wired up, in case the frontend is ever split out again.

**The claim store is gone; the server is stateless (2026-08-04).** It existed
because the website reviewed on one screen and downloaded from another, so
something had to hold the rows in between — with a one-hour TTL, a purge timer,
and the constraint that made `--ha=false` load-bearing (a claim created on
machine A 404s when approve lands on machine B).

`POST /forms/{id}/pdf` takes the final values and returns the PDF in one
request. The schema, not a stored claim, says how each field is addressed, so
nothing needs remembering. The review screen already held every row, so the
client change was one function.

What this deleted, all at once: the retention window (now genuinely zero), the
two-machine trap, the purge timer, and the reason this app could not run on a
serverless host. The remaining reason to pin one machine in `sin` is cost and
data residency, not correctness.

**Singapore region.** Clinical text should not leave SG-adjacent
infrastructure unnecessarily, so `primary_region = "sin"` stays. The app
scales to zero; a cold start measured 5.7s on 2026-08-03, which is fine for
the extension's API calls and poor for a public landing page.

**Field labels live in the schema JSON, not the UI.** Each field carries a
`label` ("ICD-10 code") alongside its `description` (the instruction the model
follows). The review screen renders `label`; raw ids like `icd_code` must
never reach the doctor. `FormField.display_label` falls back to a prettified
id so a half-written schema still renders.

**The dev fixture is hidden, not removed.** `dev_sample.json` has
`"internal": true`; `GET /forms` filters it out so a doctor is never offered a
fake form, but claims can still be created against `dev_sample_v1` by id,
which is what the API tests do.

**Precision over coverage — this is the product's core bet.** The owner's rule
(2026-07-30): *"it's much more important to get the fields that are being
filled right rather than filling all the fields up. Doctors don't mind filling
additional fields themselves."* A blank costs the doctor seconds of
handwriting; a wrong value gets signed and submitted to an insurer as their
own clinical statement. So never tune for fill rate. If a change would fill
more fields at any cost to correctness, it is the wrong change. `SYSTEM_PROMPT`
states this asymmetry explicitly and holds `inferred` to what a clinician
would conclude without hesitation. `docs/test_notes.md` case 5 is the
regression check: a one-line note should come back almost entirely `missing`.

**A field's stated date format beats the global one (2026-08-05).** Found by
running a real claim through production: the AIA form came back with
`14/03/26` in two boxes and `14/03/2026` in two others. Every date description
in `aia_ghs_claim` asks for `DD/MM/YY` — its boxes are small — while
`SYSTEM_PROMPT` mandated `DD/MM/YYYY` absolutely. AIA GHS is the only schema
wanting a short year, so the rule was right for four forms and wrong for one,
and the model resolved the contradiction differently field by field.

The prompt now defers to the field, and `_apply_date_format` **enforces** it
rather than trusting the model to comply. It only ever drops the century, and
only where the field asked for a short year, which is lossless. It never
expands: choosing between 2026 and 1926 for "26" is a guess, and a claim form
carries dates of birth as readily as dates of admission. A field wanting a full
year that receives a short one keeps what the model returned and reaches the
doctor in review.

**An ambiguous date is confirmed by the doctor, whatever its status
(2026-08-05).** The owner's call. `needs_review = status != "extracted"` asks
"did the notes say this", and for a date that is the wrong question: a note can
state `03/07` perfectly clearly and still not say whether it meant 3 July or
7 March. Nothing downstream can separate the two — the note is the only
evidence and the note is exactly what is ambiguous — so this is not a check the
pipeline can do on the doctor's behalf.

**Ambiguity is the trigger, and it has a hard boundary (narrowed same day).**
A day over 12 cannot be read as a month, so `25/07` says one thing to
everybody and is not held. Asking the doctor to confirm it would be asking them
to check something with one answer, and a confirm click that is never the
interesting one is how the ones that are get skimmed past — `aia_medical_report`
has 22 date fields. Two cases still held on purpose: a day under 13 with a
month over 12 (`03/25`) is not ambiguous but *is* written the wrong way round
already, and the row's own sentence is the correct thing to say about it; while
a value that is not a `d/m/y` string gets no recheck at all, because the
sentence would be describing nothing.

It is also the one place the usual asymmetry inverts. Everywhere else a wrong
answer is a *blank* the doctor notices; a swapped date is a **plausible wrong
answer that looks right**, signed and sent as their own statement of when the
patient was admitted.

Four things that are deliberate and easy to undo by "simplifying":

- **Rows carry a `recheck` reason, not just the flag.** A held date whose badge
  reads "Extracted from the note" above a bare Confirm button tells the doctor
  there is nothing to check. Both review surfaces render `recheck` *instead of*
  the status note.
- **Only dates that carry a value are held.** A blank is written by hand
  anyway, so holding it asks the doctor to confirm nothing.
- **Demographic dates are held too** when ambiguous, and they have the least
  excuse for being trusted: `parse_demographics` resolves DD/MM by *rule*
  (Singapore writes day first), with no model and no `source` snippet, so a note
  written the other way round is misread silently and identically every time.
  This is the one exception to "demographic = pre-approved green".
- **The website's "Confirm all" cannot reach a date.** A bulk button confirms a
  swapped date exactly as fast as a correct one, which is the failure the row
  was added to prevent. Its count says how many it will actually clear, and it
  disappears when that is none.

Both surfaces spell the value out under the box — "3 July 2026 — or 7 March
2026 if the notes wrote the month first" — and keep it in step as the doctor
edits, because a correction they cannot see take is not a correction. The rival
reading is offered only when the day is ≤ 12; 25/07 has one reading, and a
second one that cannot exist is noise that makes the real warnings skimmable.
Neither expands a two-digit year, for the same reason `_apply_date_format`
refuses to. An unambiguous date is still spelled out — a doctor scanning the
list should not have to parse digits — it is simply not held.

The demo's consultation is dated **3 July** rather than the 14 March it was
first written with, and that is load-bearing: 14/03 is unambiguous, so the
walkthrough's one illustration of this rule would no longer trigger it.
`Demo.test.tsx` asserts the day is ≤ 12 rather than asserting the literal date,
so the note can be rewritten without silently losing the demonstration.

**Still open:** the owner's spec says "date always follows dd/mm/yyyy". That
most likely means *day-first when reading a note* (so `08/02/2001` is 8
February), which is about input and does not conflict with the above. If it
means output must always carry four digits, `aia_ghs_claim` needs rewriting and
its boxes may overflow. Confirm before changing anything here.

**Doctors confirm, they don't just read.** Anything not directly `extracted`
requires an explicit confirm click before the PDF can be generated. Editing a
value counts as confirming it. Do not "helpfully" pre-confirm inferred fields.

**The parser must not require a house style (2026-08-08).** The owner's call,
and it corrects an assumption the code had quietly made: *"Doctors take notes
in many different ways so the parser should be able to take the relevant
details out of the notes regardless of the format."*

Found by running the panel's own sample note through `parse_demographics` and
getting back **one field**. `LABELLED_LINE` needs `Label: value` anchored to
the start of a line; a real note writes `NRIC S8012345D  DOB 14/03/1978` — two
fields on one line, no colon on either — and matched neither. The date of birth
was unrecoverable, because a date is never taken from unlabelled prose (a
clinical note is nothing but dates) and there was no label the rule could see.

A label is now read **anywhere in a line**, kept safe by two constraints:

- **The shape confirms the value.** Only fields with a shape take part — NRIC,
  phone, policy number, date. The label says *which field*; the shape says
  whether what follows is really one, so `Policy discussed with patient`
  contributes nothing. Name and address are excluded from this pass entirely:
  they have no shape, so there would be nothing to check a guess against.
- **A label must open a field**, meaning it starts the line or follows a
  separator. Without this, `Clinic tel 62551234` reads as the patient's phone
  — the clinic's own number, under the doctor's signature, written onto a
  claim as theirs. `test_two_phone_numbers_means_neither` caught exactly that
  on the first attempt, which is the reason the rule exists. The same shape
  covers `Next of kin phone`.

Two candidates behind one label still yields neither, exactly as unlabelled
prose does. The refusals are unchanged; only the reach is wider.

**A shape has to be a whole token, not the tail of one (2026-08-08).** The
collision this fixes: `Policy GHS-88213004` came back with the policy number
*and* a phone number of `88213004`. Eight digits opening with an 8 is a valid
Singapore mobile, so the unlabelled-prose pass claimed the policy number's
tail — a wrong value in a shaped field, and the worst kind, because
demographics are copied onto the form deterministically and so bypass both the
model and the review confirm. It fires on any note with one such policy number
and no phone, which is an ordinary note.

The rule is `PHONE_IN_TEXT`: a phone must be delimited by something that is not
identifier material — no letter, no digit, none of the connectors (`-` `/` `#`)
that bind a reference together. Read the whole token first; if the digits are
only part of it, they are not a phone number.

Two things about it that look like inconsistencies and are not:

- **`SG_PHONE_PATTERN` in `redaction.py` is deliberately left blunt.** It
  guards only against a longer *digit* run, which is all redaction needs:
  redaction blanks what it matches, so over-matching there costs nothing and
  under-matching is a leak. Only the module that *assigns a value to a field*
  needs the stricter question. Do not "unify" the two patterns.
- **It is not applied to `NRIC_PATTERN`.** A phone number is never embedded in
  a reference, but an NRIC in one (`REF-S8012345D`) is still the patient's, and
  refusing it would lose a correct value to avoid a collision that does not
  happen. `test_an_nric_inside_a_reference_is_still_the_nric` pins it.

Why three suites never saw it: the fixtures use `GHS-4471902` (seven digits)
and `GE-88213` (five), and the panel's own sample note happens to carry two
policy variants, so the sole-match saw three candidates and refused. It was
masked everywhere it was exercised. A useful generalisation — **a refusal is
not evidence of a working rule.** Both of these look identical from a test that
only asserts `is None`.

**One paste box, and the split is done by patterns — never by a model.** The
owner's call (2026-08-03): seven inputs and a note box collapse into a single
textarea; the doctor pastes the consultation as it sits in the CMS.

The question that actually mattered was who does the splitting, and the answer
is not a style preference. **`redaction.py` pass 1 uses the demographics AS THE
DICTIONARY** it scrubs the note with, because a name has no shape for a regex
to find. A model asked to split the block would have read the patient's name
and NRIC *before any dictionary existed* — and the note could no longer be
scrubbed of the name either, because nothing would know what it was. The
ordering is the privacy model, not a preference. `backend/demographics.py`
does it with the patterns `redaction.py` already defines.

What it refuses to do is most of the design, and it is the same bet the rest
of the product makes:

- A labelled line is believed. A shape in unlabelled prose is believed **only
  when it occurs exactly once in the whole paste** — every note in
  `docs/test_notes.md` carries the clinic's own phone number under the
  doctor's signature, so two candidates means neither is returned.
- **A date of birth is never taken from unlabelled text.** A clinical note is
  nothing but dates: consultation, admission, discharge, MC.
- **A name is never guessed at all**, from anything.
- Compound patient lines are split by segment, because that is how the pilot
  writes them: name, NRIC, DOB, phone, address, policy on one middot-separated
  line — which also *wraps*, so continuation lines are rejoined when the
  previous line ends in a separator.

The parsed fields stay on screen and stay editable, in a drawer that opens
itself when something required is missing. They are not a summary: they are
what redaction searches for, so a name that arrived wrong there is a name left
in the text that goes to the model.

It lives on the server rather than in the panel for the same reason redaction
does — a JavaScript copy of those patterns that drifted from the Python one is
a leak.

**Auto-filling demographics from the clinic CMS was investigated and
deferred.** Recommendation stands: paste-and-parse (extract NRIC/DOB/phone
from one pasted block using the regexes already in `redaction.py`) before any
CMS integration. If integration happens, it must run *inside* the clinic — a
local agent or browser extension — never a hosted server holding standing
credentials to a patient database. See conversation history for the full
comparison (ClinicAssist / Assurance Technology, NEHR via Synapxe GPConnect).

**Insurers increasingly send a link, not a PDF — so a third fill target is a
browser extension.** AIA's ClaimEZ mails the doctor a tokenised link
(`https://claimez.aia.com.sg/doc/?pid=<uuid>`) to a JS-rendered form filled and
submitted in the browser. A filled PDF is the wrong artefact for that channel.

Routes considered and closed (2026-08-01), so they are not re-opened:

- *Print, hand-fill, scan back in* — more friction than the product removes.
- *Download the PDF from ClaimEZ and use the existing pipeline* — the download
  only appears **after** submission. It is a receipt, not an input.
- *Any other submission route (email the PDF, upload elsewhere)* — the owner's
  call, and the stronger argument: the link is what the insurer handed the
  doctor, and moving them off it adds friction rather than removing it. **The
  submission channel is fixed. Fill the channel the doctor was given.**
- *Iframe the portal inside BreezeFill, or have the server open the link* — CSP
  blocks the first; the second makes the server hold a bearer credential to a
  patient's claim.

So: `extension/`, a third `fill_mode` alongside `acroform` and `overlay`. Fill
in place, never submit — the doctor still clicks submit and signs.

**The `?pid=` in a ClaimEZ link is a bearer credential.** Anyone holding the
URL gets a page pre-populated with the patient's name, NRIC and policy number.
It is not an id, it is a password. Never log it, never paste it into a
transcript, never let it into an authoring artefact. `extension/learn/dump.js`
records the **host** only, for this reason.

**Learn mode has no demographics dictionary, so it cannot scrub names.** This
is the trap that shaped `extension/learn/dump.js` and it will catch anyone
extending it. The scrubber finds identifiers *by shape* — NRIC, phone, email,
digit runs. A name has no shape: `Tan Wei Ming` is indistinguishable from
`Tan Tock Seng` by regex. `redaction.py` only handles names because pass 1 has
the demographics the doctor typed in; on an insurer's page nobody has typed
anything. Consequences, both of which look like over-caution until you see the
page:

- Section and step text come from `<legend>` only, never `<h1>`/`<h2>`/prose.
  A claim page heading reads "Claim for &lt;patient&gt; (&lt;NRIC&gt;)".
- If scrubbing changes *any* option in a list, the whole list is withheld. A
  policy picker reading `80123456 — Tan Wei Ming — GHS` has a shaped number
  next to an unshaped name, so partial scrubbing emits the name.

A dump gets pasted into a model to draft a schema, which makes it an LLM input
and subject to the same rules as clinical text. See `extension/README.md` for
the residual risks that remain.

**The product is the extension; the website is not the surface.** The owner's
call (2026-08-03). The doctor pastes into a side panel next to the insurer's
form rather than into a separate site.

The justification worth keeping is not "the forms arrive on insurer websites" —
that argues only for an extension existing, which was already settled. It is
what the pivot *deletes*. With a separate website the note lives on origin A
and the form on origin B, so the design needed `externally_connectable`, a
handoff protocol, a claim id to correlate the two, and a **server-side session
to hold the claim between "typed the note" and "filled the form"**. Put the
paste area beside the form and none of that has a reason to exist.

Hence `POST /map`: same review rows, no claim id, nothing stored, nothing to
purge. Retention is zero — and as of 2026-08-04 the PDF path works the same
way, so this is no longer a property one path has and the other lacks. `redact →
map → assemble` lives in `_review_rows` so both endpoints share one path — a
second caller that reimplemented it is how a route that skips redaction gets
introduced.

**The website's job is now to hand out the extension** (2026-08-03). The owner's
call, and the completion of the pivot above: `#/` is a landing page, `#/demo` is
a walkthrough, and the download button serves `extension/` zipped from the
source tree.

Three things decided while building it that are easy to undo:

- **The claim UI was moved, not deleted.** Deleting it would have taken the
  five PDF forms with it — they are real forms doctors still receive and this
  is their only interface. It lives at `#/app`, unadvertised.
- **The demo talks to nothing.** No fetch, no model, every value written into
  `Demo.tsx`. It therefore works while the machine sleeps and cannot be spoiled
  by a bad generation. Do not "improve" it by wiring it to the live API.
- **The demo will not let you skip the confirm step**, and the field the note
  cannot answer stays blank in the filled form. Both are asserted. A demo that
  glossed over either would teach a doctor the wrong thing about what they are
  signing, which is worse than having no demo.

The landing copy is held to the same standard: `Landing.test.tsx` fails if the
page ever claims to be fully automatic or to need no review. The product's
pitch is a set of refusals, and marketing copy is where those get softened.

What did **not** change, and must not:

- **"Fully an extension" does not mean serverless.** The API key cannot ship
  in an extension; a packed `.crx` is a zip. The backend stays.
- **The review step moves, it does not disappear.** Anything not directly
  `extracted` still needs an explicit confirm before it is written into the
  portal. The pivot must not quietly become fill-then-eyeball.
- **The five PDF forms stay.** Not every insurer sends a link, and they work.
  What stops is *investment in the website*, not the acroform/overlay paths.

~~Redaction stays server-side for now.~~ **Done — redaction moved into the
browser, and this paragraph described the world until 2026-08-17.** What it
called "strictly better" is what now happens: the demographics never leave the
tab, `/map-redacted` receives no `PatientRecord`, and a log or a crash dump on
the server cannot contain a patient's name because one was never sent.

The objection it raised was the right one and was answered rather than
accepted. Two implementations of one rule do drift, so:

1. **The shapes are not written twice.** `extension/privacy/patterns.json` is
   read by `redact.js` and by `redaction.py`. Editing one file changes both.
2. **`tests/fixtures/redaction_corpus.json` runs against both** — 12
   adversarial cases, same notes, same assertion that no identifier survives
   and that the clinical content the mapping call needs does.
3. **The server redacts again** on text the browser already redacted, and
   discards its own map. A miss in the browser is then a bug rather than a
   disclosure — *except for a name*, which pass 2 cannot catch. See the hard
   rule about pass 3.

What is genuinely duplicated is pass 1's regex construction (`nameRegexes`,
`dobRegexes`), which is hand-ported. `redact.js` exports both for the tests
that check the two languages agree; keep that export.

The one thing browser redaction cannot fix is that an extension updates on
Chrome's schedule. `MIN_EXTENSION_VERSION` in `main.py` is the answer — raise
it and every older panel refuses to map *before* it redacts. Raise it only for
a fault that makes the old build unsafe.

**The extension holds no standing access to anything.** `manifest.json`
declares no `content_scripts`, no default `host_permissions`, and — this is
the easy one to undo by accident — **no `tabs` permission**, which would expose
every tab's address. `panel.js` therefore never learns what site it is on; it
finds out from the injected script's own `location.host`, after the doctor
granted `activeTab` by clicking the toolbar icon on that tab. Consequence to
accept rather than route around: opening the panel on one tab and switching to
another means clicking the icon again. `optional_host_permissions` is declared
but not yet requested — it is there for the `MutationObserver` work, which
needs access that survives a wizard step.

`chrome.storage` holds the licence key and nothing else (2026-08-17): patient
notes must not reach disk. This is also why `background.js` is nearly empty —
a service worker acting as a message broker is evicted after ~30s idle, so it
would have to persist the note to survive. State lives in the panel.

**Superseded 2026-08-05 — the bank is no longer a gate.** The owner's call,
after seeing the real ClaimEZ form: *"there's no need to check if the current
form being filled is already in the bank, because the doctors will have to
submit a filled form online regardless."* That reframes what identification was
ever for. The doctor must submit the form on their screen whatever this
repository knows about it, so the answer to "is this in the bank" can only
change **how well each question is answered**, never whether they are
attempted.

So there is now **one path**: every fillable control on the page becomes a
question to map. A schema that fits lends its `description` to the controls it
describes; a schema that does not fit costs sharpness and nothing else. No
picker to get past, no fallback to opt into, and no state in which the panel
looks at a form it declines to fill. `mappingLive()` survived as a *report* —
"did the bank describe any of this" — gating only the draft-schema offer, and
**went with it on 2026-08-17**: with nothing left to gate, a helper answering a
question nobody asks is a thing to delete rather than keep.

**The privacy property was kept, not traded.** A described control travels
under the *schema's* wording rather than the page's, so a page the bank fully
describes sends exactly what the old schema route sent. Only questions nothing
describes carry their own labels out, which is the irreducible cost of
answering them at all. The join runs in the page (`locate.enrich`), so schema
instructions reach controls without page structure being sent anywhere to
arrange it.

**What one path quietly broke, found 2026-08-09: demographics were never
filled.** `_live_schema` stamped every control `source="llm"`, and the
consequence was not a weaker answer to "Patient's Full Name" but **no answer at
all** — demographics are exactly what redaction strips first, so the model read
`[PATIENT]` and correctly returned `missing`, while the value sat in the
`PatientRecord` the whole time. Every claim on the extension's only path left
the name, NRIC, date of birth, phone, address and policy number blank.

The name is the sharpest case and the reason this is not a coverage
nicety: **it is required at step 1 of the panel, so it is always known**, and
it was the one field guaranteed to come back empty. The others are conditional
on being known — which is the right condition, and now the one that applies.

`_live_sources` resolves a control's label through
`demographic_field_for_label`, which is exact against the alias table
`demographics.py` already owns, so the note parser and the form reader cannot
drift apart. Three refusals guard it, and they matter more than the fills
because a value assigned this way skips the model and reaches the doctor
already green:

- **An unrecognised label stays `llm`.** The qualifier list is an allowlist, so
  `Hospital name`, `Doctor's name`, `Employer name` and `Name of attending
  physician` resolve to nothing while `Patient Name`, `Name of Patient` and
  `Full name` all resolve.
- **A control inside a repeating entry is never demographic.** `instance` means
  the question is asked once per entry — several dependants, several admissions
  — and one patient record cannot answer the second one.
- **Two controls wanting the same demographic yields neither.** A form with
  "Name" in the patient block and "Name" again in the physician block cannot be
  told apart from the label, and filling both writes the patient's name into
  the doctor's box. The same refusal `locate.js` makes over three identical
  "Date Of Birth" labels.

**It moves data away from the model, not toward it.** This reads backwards
until you check `map_fields`, which sends `schema.llm_fields`: recognising a
control as demographic *removes* its question from the grammar and the prompt.
`test_a_demographic_control_is_not_sent_to_the_model` asserts it.

`schemaFieldsOf` in the panel still filters demographics out of enrichment, and
that stays correct on its own terms — a demographic field has no `description`
to lend. It is simply no longer the whole story.

**The limit, found by a test that expected to pass.** Enrichment matches by the
same label scorer filling uses, and it compares words rather than meaning:
"7. When did the patient first consult you" and "Date of first consultation"
are the same question, share one content token, score 0.22, and do not match.
It fails safely — the control is still filled from its own label, just without
the sharper instruction — but it means **a web schema wants labels authored
from the page's own wording**, which is what the draft-schema flow produces,
rather than from the labels of the equivalent PDF form. Do not assume
`aia_ghs_claim`'s labels will enrich the ClaimEZ page; they were written for a
PDF.

Below is the superseded three-step design, kept because steps 2 and 3 are still
exactly what happens — what changed is that step 1 stopped being able to stop
anything:

**The bank, then the page. And filling an unknown form produces the schema
that replaces it.** The owner's design (2026-08-03). Three steps:

1. **Is this form in the bank?** Answered by *fingerprint*, not by reading an
   id out of the markup. Every schema is scored against the live controls and
   the best fit wins — which asks "does this page carry the fields this schema
   describes", the thing that actually matters, instead of a version string
   that rots at the insurer's next deploy. Host matching still runs first and
   narrows the shortlist; it cannot settle it, because an insurer serves
   several forms from one domain. A tie is not a winner.

   Identification runs at *looser* thresholds than filling (`IDENTIFY_MIN_RATE
   = 0.4` vs `MIN_MATCH_RATE = 0.7`) and that is safe rather than sloppy: a
   wizard shows one step at a time, so the right schema may only find a third
   of its fields on the page in front of us. Whatever is picked still has to
   clear the fill guards before a value is written. Identifying is choosing
   what to *try*.

2. **If nothing fits, map against the page itself** — `POST /map-live`. The
   field list comes off the live controls; same redaction, same review rows,
   same confirm-before-write. Offered only when nothing in the bank fits, and
   never the default, because it is **strictly weaker**: a schema's
   `description` is the instruction you would give a colleague ("the date the
   patient FIRST consulted this doctor for this condition, not the latest
   visit") and a page can only supply the question as it is worded.

   The cost was accepted deliberately and is the one thing the schema path was
   built to avoid: **page structure becomes an LLM input on every claim mapped
   this way.** Labels are scrubbed twice — once by `dump.js` in the browser,
   once by `scrub_patterns` on the way in — and it still cannot catch a name,
   because a name has no shape. `test_a_name_in_a_label_is_the_known_hole`
   asserts the failure so nobody rediscovers it by accident.

3. ~~**A successful schema-free fill hands back a draft schema**~~ — **removed
   2026-08-17. See "The draft schema is gone" below.** It was a proposal for a
   human to read and commit, never installed or auto-PR'd, and it appeared while
   the page that produced it was still on screen. What ended it was the audience:
   the human reading it was a GP, and the reason it was safe to offer at all —
   that a schema only ever makes answers sharper — is also the reason nothing was
   lost by deleting it.

Two traps found while building it, both in the draft:

- **`hosts` gets the full host, never a guessed registrable domain.** "The
  last two labels" of `claimez.aia.com.sg` is `com.sg`, and `hostMatches`
  matches subdomains — that schema would have claimed every commercial site in
  Singapore. Widening it by hand is a one-word edit; a schema that silently
  claims a TLD looks correct in review.
- **The draft includes fields this note left blank.** A schema describes the
  form, not one claim against it. Dropping the blanks would stop a later,
  fuller note from ever filling them.

**Screenshots and a VLM were considered for step 2 and rejected (2026-08-03).**
The argument that settled it is not the privacy one, though that holds too — an
insurer's claim page arrives pre-populated, so a screenshot of it is a picture
of the patient's NRIC, and every pass in `redaction.py` operates on text. The
stronger argument is that **a screenshot redacted enough to be safe contains
less than the dump already does**: you would have to black out every control
(they hold patient values) and every heading and paragraph (names have no
shape), leaving labels and layout — and labels are already extracted, scrubbed,
with the layout question answered by rule 6. The increment a screenshot buys
over the dump is essentially the prose, which is exactly the part that carries
the name. A VLM would also return *coordinates*, and mapping those back through
`elementFromPoint` trades a reliable locator for an unreliable one when the DOM
is already in hand. Use a model for meaning, the DOM for location.

**The filler is hybrid: live structure locates, the schema means.** The owner's
design (2026-08-01). The extension reads the form structure *at fill time*
rather than trusting a selector map authored months earlier, which is what
stops the map rotting when an insurer redesigns. But the live page cannot
supply *meaning*: with structure alone, the model's whole instruction for a
field is whatever text the page renders — sometimes `4a`, sometimes a truncated
string — and it would be inferring what an unfamiliar field wants before a
doctor signs the result. So the schema still supplies each field's
`description`, and the two are joined by label text (`extension/fill/locate.js`).

Two consequences worth keeping:

- **Page structure never leaves the browser.** The server sees the schema (no
  patient data) and the redacted note, and returns values keyed by field id,
  exactly as today. Locating happens client-side where the structure already
  is. A pure live-read design would have made page structure an unreviewed LLM
  input on *every* claim; this way that path does not exist.
- **A live field with no schema match is left blank**, and reported as a
  schema-authoring candidate. Precision over coverage, applied to matching.

`MIN_MATCH_RATE` is the important knob: below it the filler writes *nothing*
rather than filling the part that still matches, because a partial fill is
indistinguishable from a complete one to someone reviewing quickly. Confirmed
in a real browser on 2026-08-03 — an AIA GHS plan against RoboForm's 39-field
test page filled nothing.

**`MIN_MATCHED` guards the other end, and is not optional.** A ratio clears
trivially on a small plan: one ready field scoring against one label anywhere
is a match rate of 1.0. A sparse clinical note produces exactly that plan —
mostly `missing` rows and two or three values — so it is the common case, not
a corner. Both guards apply, never either: the rate says the page has the
schema's shape, the count says there is enough evidence for the rate to mean
anything. Consequence to accept: a note that yielded one or two values gets no
autofill at all.

### Design decisions not yet resolved

*Open on purpose. Each was left rather than guessed, and each names what would
settle it. Do not close one by picking the convenient side in passing.*

**`locate` and `enrich` disagree about a collision, and only one of them can be
right (2026-08-11).** Both join labels with the same scorer, the same
`MIN_SCORE` and the same `TIE_MARGIN`, and since the enrichment fix both assign
strongest-first. They part company on what to do when the thing being claimed
is already taken:

- `locate` **refuses**. A field whose best control is claimed is reported
  `ambiguous` and nothing is written.
- `enrich` **falls through** to the control's next-best unclaimed field, which
  still has to clear `MIN_SCORE` and the tie check on its own.

The case for leaving them different is that the stakes are not symmetric. A
refusal in `locate` is a blank the doctor writes by hand; a refusal in `enrich`
only means a control is answered from the page's own wording instead of the
schema's, which is the documented weaker-but-safe direction. On that reading
`enrich` should stay permissive, because the fall-through is independently
evidenced — the second field cleared the same bar the first one did.

The case for making them the same is that a wrong `description` is the one
error nothing downstream can catch. A mislocated *value* is visible in review
next to the question it landed under; a wrong instruction produces a
plausible-looking answer to a question the doctor is not being shown, and the
review screen renders it exactly like a right one. That argues `enrich` should
refuse too.

**What would settle it: the ClaimEZ dump.** The disagreement only bites on a
page carrying two controls that ask a similar question, and nobody knows yet
whether the real form does. If it does not, this is theory. If it does — a
"Ward class" in the admission block and another in the requested-fees block,
say — the dump shows the actual labels and the answer stops being a preference.

Related and still open elsewhere: whether a step hidden behind `display:none`
should be fillable (`isFillable` checks `disabled` and `readOnly`, not
visibility) — see "All three are still gated on the same thing". Same shape of
question, same thing unblocks it.

**How to tell a grid-layout question row from a repeating-entry opener
(2026-08-15).** Both open with a bare element holding text, so `hasDelimiter`
calls both an entry — see the trap of that name for what it costs, which on a
wholly grid-laid-out form is every demographic control refusing to fill. This
is listed here rather than fixed because every candidate discriminator trades
one false-positive class for another, and choosing between them from a verbal
description of ClaimEZ is how the wrong one gets locked in. **Three open
questions now wait on the same dump**; this is the third.

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
  `docs/test_notes.md` remains synthetic because repo fixtures still must be.

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

## Commands

Paths are macOS/Linux (`.venv/bin/python`) as of 2026-08-06. On Windows the
same venv puts the interpreter at `.venv/Scripts/python.exe` — see the
toolchain note below, which is the whole of what changes between the two.

```bash
# tests (offline, no API key needed)
.venv/bin/python -m pytest -q

# extension tests (separate toolchain — vitest + jsdom, from the repo root)
npm install && npm test

# website tests (a THIRD project: its own vitest, its own jsdom, React plugin)
cd frontend && npm install && npm test
# Both vitest projects carry an explicit `include`. Without one the root runner
# discovers frontend/src/*.test.tsx and runs them without the React plugin —
# 28 failures that look like the website is broken when it is green.

# load the extension: chrome://extensions -> Developer mode -> Load unpacked
# -> select extension/. Reload it after every change; the side panel needs
# reopening, and content scripts need the insurer tab reloaded too.
# Point it at a local backend via the panel's Advanced -> Backend URL.

# backend dev. The key must be exported IN THIS SHELL — the extension's only
# backend is this process, and without the key POST /map returns 503.
export ANTHROPIC_API_KEY=...    # never via Claude Code's `!` prefix: it is logged
.venv/bin/python -m uvicorn main:app --app-dir backend --port 8000

# ...except for the RoboForm route, which needs NO key at all. Its schema is
# all-demographics, so map_fields never calls the model; disabling the sweep
# removes the only other call. FORMFILL_SHOW_INTERNAL puts the test schema in
# the picker, which is the only way the panel can name it.
export FORMFILL_SHOW_INTERNAL=1 FORMFILL_DISABLE_SWEEP=1
.venv/bin/python -m uvicorn main:app --app-dir backend --port 8000
# then: https://www.roboform.com/filling-test-all-fields, click the BreezeFill
# icon ON THAT TAB, paste a case from docs/test_notes.md, Map, Fill.

# frontend dev (expects backend on :8000)
cd frontend && npm run dev            # http://localhost:5173

# production shape locally: build the frontend, then hit the backend alone
cd frontend && npm run build          # backend then serves it at /
.venv/bin/python -m uvicorn main:app --app-dir backend --port 8100

# dump a PDF's field names when adding a form
.venv/bin/python backend/pdf_fill.py forms/your_form.pdf

# Vercel. Login and `env add` need a real terminal; everything else runs from
# here once auth exists. `vercel env ls` prints names and "Encrypted", never
# values.
#
# Auth is NOT at ~/.vercel on macOS — it lives in
# ~/Library/Application Support/com.vercel.cli, so an absent ~/.vercel proves
# nothing. Check with `vercel whoami`, which is the only reliable test.
# `vercel link` here wrote .vercel/repo.json (repo-level) and an OIDC token
# into .env.local; both are gitignored, and .env.local holds a credential, so
# keep it that way.
vercel whoami                       # is anyone logged in at all
vercel domains ls --scope breeze-fill
vercel domains inspect breezefill.com --scope breeze-fill   # prints the DNS records needed
vercel alias ls                     # which hostname points at which deployment
vercel deploy --yes                 # preview
vercel deploy --prod --yes          # production
vercel env ls

# Probing a PROTECTED preview: only `vercel curl` carries the SSO bypass, and
# the URL must come FIRST. See Traps — it reads the first path-like token as
# the path, so `-o /dev/null` silently fetches /dev/null instead.
vercel curl https://<deployment>/health
vercel curl https://<deployment>/map -s -i -X POST \
  -H "Content-Type: application/json" --data-binary @probe.json
```


The `!` prefix in Claude Code runs **Bash**, not PowerShell.

**Toolchain quirks that cost a session to work out.** The lesson generalises
past the machine it was learned on: when a suite will not run, the cause has
twice been the *toolchain path*, not the code. Check that before concluding
anything is broken.

*macOS, the current machine (2026-08-06).* `node`/`npm` come from **nvm**,
which `~/.zshrc` loads for interactive shells only — so a non-interactive
shell (Claude Code's Bash tool, a hook, a cron) reports `command not found`
while the user's own terminal is fine.

Derive the path instead of hardcoding a version:

```bash
export PATH="$HOME/.nvm/versions/node/$(ls ~/.nvm/versions/node | tail -1)/bin:$PATH"
nvm use --lts     # if nvm is loaded (interactive shells only)
```

**SET `git config user.email` BEFORE COMMITTING ON A NEW MACHINE. Vercel
blocks deployments from commits it cannot attribute (2026-08-06).** This cost
an entire afternoon and every symptom pointed somewhere else.

A fresh macOS install has no `user.email`, so git silently invents one from
the hostname — here `edwardthng@Edwards-MacBook-Pro.local`. Commits succeed
and push fine. GitHub accepts them. But the Vercel GitHub integration
**refuses to build a commit whose author email is not a valid GitHub
account**:

> The deployment was blocked because the commit author email
> (edwardthng@Edwards-MacBook-Pro.local) is not valid. Ensure your git email
> matches your GitHub account.

Fourteen deployments accumulated over one afternoon, none of them ever built.

**The reason it is so expensive to diagnose is that the CLI never says this.**
The message above appears only in the Vercel dashboard. From the terminal:

- `vercel ls` → `UNKNOWN` status, `?` duration, for every deployment
- `vercel inspect --logs` → one line, `status UNKNOWN`, no log at all
- `vercel promote` → `not ready and cannot be promoted (422)` — the closest
  thing to a real signal, and it reads like a build still in progress

**A blocked deployment is indistinguishable from a slow one over the CLI.**
The tell is that a *hours-old* deployment still reports "not ready": a queue
drains, a blocked deployment never does. Check the dashboard the moment two
deployments of different ages both say it.

Check before committing on any new machine:

```bash
git var GIT_AUTHOR_IDENT     # must show a real GitHub-registered address
```

*Two things were wrongly blamed first, so they are recorded here as ruled
out:* a `.nvmrc` pinning Node 26 against a project set to 24.x (plausible, and
Vercel does read `.nvmrc` — but it was not this), and a build-queue backlog
from many pushes. Neither was the cause. `.nvmrc` was deleted anyway and the
commands above derive the node path instead, which is the better arrangement
regardless.

Also absent: `timeout` (GNU coreutils, not a macOS builtin), and `python3` is
3.14 where the old venv was 3.11 — every dependency is `>=`-pinned, so 3.14
resolves clean and the whole suite passes on it.

*Windows, the previous machine.* On the OneDrive-synced copy, `node`/`npm`
were installed but invisible to both the Bash tool and PowerShell's
`Get-Command` — reached through `cmd /c "npm test"`. And `.venv` had been
created under a different Windows user profile, so `.venv/Scripts/python.exe`
resolved to a path that did not exist (`C:\Users\thnge\...`).

**A venv and a `node_modules` do not survive a machine move, and they fail
differently (2026-08-06).** Both are gitignored, so a repo copied between
machines carries neither correctly — but only one of them says so.

- The **venv** is a directory of absolute paths to an interpreter that is not
  there. Obvious the moment anything runs.
- **`node_modules` is the quiet one.** npm installs *platform-specific* native
  binaries, so a tree installed on Windows holds `@esbuild/win32-x64` and
  `@rollup/rollup-win32-*` and nothing that can run on a Mac. It looks
  complete, `npm test` looks like it should work, and the failure reads as a
  broken build rather than a wrong architecture. Confirm with
  `ls frontend/node_modules/@esbuild` — the answer should name the host you
  are on. The fix is `rm -rf` and reinstall, not a repair.

Recreating both after a move:

```bash
rm -rf .venv && python3 -m venv .venv
.venv/bin/python -m pip install -r backend/requirements.txt

rm -rf node_modules frontend/node_modules
npm install && (cd frontend && npm install)
```

The backend serves the frontend only if `frontend/dist` exists — that is why
local dev without a build still works, and why the Dockerfile builds it in a
node stage.

---

## Next steps

Ordered by what unblocks the most. Items 1 and 2 are the only ones that are
not waiting on something.

**1. Get a learn-mode dump from a live ClaimEZ page — one per step.**
Everything about the real target is currently a verbal description. A dump
gives the field labels, the dropdown option text, the `<legend>` that names
each step, and whether the controls are native or custom widgets. It is
read-only, does not consume the `?pid=` token, and unblocks items 3, 4 and 5
at once. Paste `extension/learn/dump.js` into the console on the form page,
run `breezefillLearn.dump()` per step, then `mergeDumps([...])`. Read it before
sharing it — see `extension/README.md` for the residual risks.

**Four open questions now wait on this one dump**, and it is worth listing them
together because each has been deferred rather than guessed:

1. Should a step hidden behind `display:none` be filled? (`isFillable`)
2. Should `enrich` refuse a taken control the way `locate` does?
3. How do you tell a grid-layout question row from a repeating-entry opener?
   Today you cannot, and on a wholly grid-laid-out form that refuses every
   demographic control — see the trap.
4. What wordings do the real labels use? The demographic alias table is
   narrower than ordinary phrasing (`Contact No.` yes, `Contact Number` no)
   and widening it on a guess is how the wrong label starts resolving.

Three of the four were found by building things against a verbal description
and finding the description did not decide them. That is the argument for
getting the dump before writing more mechanism, not after.

**2. ~~Finish the Vercel migration~~ — done 2026-08-05.** Production is live and
public, the key is set for both environments, `DEFAULT_API_BASE` points at it,
and Fly is destroyed. One residual: **previews sit behind Deployment
Protection**, so the extension cannot be pointed at a preview URL (its `fetch`
401s and reads as "Could not reach the backend"). Production is public, so
testing against production works — turn protection off only if you want preview
builds testable too.

**2b. ~~Get the extension onto the Chrome Web Store~~ — DONE, and it is public.**
The listing went live on 2026-08-17 at version `0.2.1`. **Unlisted** is what this
file recommended and is no longer what happened; the reasoning below is kept as
the record of the decision, not as an instruction.

The argument for the store still holds and is worth keeping, because the stopgap
now on the site contradicts it: "download a zip, enable Developer Mode" is not
something a GP will do, and Chrome blocks self-hosted `.crx` outside enterprise
policy, so the store is the only real route. `#/get` step 2 points at
`/download` anyway right now, because the published version does not run — a
worse install that works beats a better one that does not. **It is temporary.
Revert it when 0.3.0 is approved.**

**The work now is the 0.3.0 upload**, which is an update to a live listing rather
than a first submission. See the version table at the top of Status.

**The owner's call, 2026-08-08: submit now and keep refining while the review
runs.** Review takes weeks, so the queue time is free if the work continues in
parallel — and an unlisted item can be updated after approval. What this
decision accepts, explicitly, is that **the extension has still never filled a
real insurer form** (next steps item 1), so the first version in the store is
one whose core path is proven only against RoboForm and synthetic fixtures.

**Status 2026-08-12 — every asset exists; the listing form is the work.**
The full state is in the store-submission table under Status, and every string
to paste is in **`docs/chrome-web-store-submission.md`** — that file is the
one to open, not this one.

Cleared since this was written: the four screenshots, the 440×280 promo tile,
the permission justifications and single-purpose statement, the remote-code
answer, and the package itself at `0.2.1`.

What is left:

1. **Finish the listing form and submit.** Long description, category,
   language, the four screenshots (lead with `3.45.53`), icon, promo tile, the
   Privacy tab. Distribution is **public** as of 2026-08-17 — this line said
   Unlisted, and that is not what shipped. Name and short description come from
   the manifest and cannot be edited there.
2. **If the upload fails again, get the exact error text.** The package has
   been verified clean offline every way available — root manifest, no BOM,
   valid JSON, every internal reference resolving, icons at their declared
   sizes, 78 KB against a 20 MB limit — so the next signal has to come from
   the dashboard rather than from another local check.

Four screenshot traps, all met on the first attempt (2026-08-11), all still
true for a retake:

   - **Crop, or the argument is unreadable.** A whole-window capture puts the
     panel's copy at ~9px. `scripts/store_screenshots.py --crop right:62` was
     the balance; a step whose content sits lower in the panel wants an
     explicit `x,y,w,h` box instead, because the fractional form anchors at the
     top.
   - **`Cmd+Shift+B` first.** The bookmarks bar puts personal browsing into a
     public listing and survives the crop.
   - **Turn off the floating thumbnail.** Three of four retakes were lost to
     it — see Known gotchas.
   - **Reload the extension before shooting.** The first set photographed a
     stale build and showed problems that were already fixed.

The **data-safety disclosures** must agree with `privacy.html` line for line;
the store asks the same questions and a mismatch is a rejection, not a query.
Tick PII, Health information **and Website content** — the third is the one
that gets missed, and `/map-live` genuinely sends the page's question labels.

Icons are done. Expect weeks rather than days: health data plus a permissions
story means manual review, and a rejection restarts the clock.

One thing that no longer blocks it: **the Vercel plan is Pro since
2026-08-06**, so commercial use is permitted and the pricing page is unblocked.
And note that the "synthetic notes only" rule that used to be listed here was
**overridden by the owner on 2026-08-06** — real consultation notes are in
scope, and the privacy policy discloses the out-of-region transfer rather than
forbidding the data. See the guardrail; do not reinstate the old rule here.

Owner's terminal for anything holding the key — a key pasted into a transcript
is a key to rotate.

**2c. Build the paid tier, in this order.** The design is settled — see
"Pricing, and the gate that does not exist yet". Nothing here blocks the store
submission, and the submission should not wait for it.

1. **Stripe payment link + price** (owner). Setting `VITE_STRIPE_PAYMENT_LINK`
   at build time is all the site needs to turn the pricing card's placeholder
   into a working Subscribe button.
2. **A post-payment page** that hands over the licence key and the store link.
3. **Licence verification in the backend**, by asking Stripe whether the
   subscription is active — no subscriber table of this repo's own.
4. **A licence field in the panel.** This is the part that costs a second
   store review, so it is last.

Two things to settle before the first real charge, both the owner's: the
**legal entity** on the Stripe account (moving from sole trader to a company
later means a new account and re-onboarding every card), and whether the free
pilot installs are grandfathered — Chrome's terms say they must be.

**2d. Gate the deploy on CI.** `.github/workflows/tests.yml` runs the three
suites on every push but only reports; `main` is production and Vercel deploys
it regardless, so a red suite still ships. The shape that fits this repo's
"commit after every file change" habit is to **turn off Vercel's automatic Git
deploys and deploy from the workflow after the tests pass** — pushing stays
exactly as it is, production simply updates a few seconds later and only when
green. Needs a Vercel token in GitHub secrets, which is the only secret in the
whole setup. Add a post-deploy smoke check on `/health`, `/forms` and the
download route while the store review is running.

**3. ~~Wizard support~~ — built 2026-08-04, first exercised 2026-08-06.**
`tests/fixtures/wizard_like.html` and `wizard_test_v1` (`internal: true`) turn
it on: `<legend>`-named steps, three question types each, a URL that never
changes, and a repeating question with an "add another" button. Against the
two-step version of that fixture, whole-plan `locate` scored 3/6 and refused
while `locateSteps` scored 3/3 and filled — the exact failure the per-step
guard was written for.

**Reworked 2026-08-15 into three steps, and it is now also the form the
website's demo video is shot against.** What that added, each of which was
uncovered by any fixture before: a demographic step (since 2026-08-09
`_live_sources` answers those controls from the record and removes their
questions from the mapping call), the repo's only native `<input type="date">`,
a checkbox group carrying an explicit "None of the above", two grid-layout
labels, and a pre-filled control for the never-overwrite guard. The third step
asks about a hospital admission the panel's sample note cannot answer, on
purpose — a demo where every box fills teaches the opposite of the product's
bet, so the blanks are part of the shot.

**The pre-filled control moved on 2026-08-17, and where it sits is the point.**
It was `Insurer`, hardcoded to "AIA Singapore", and that made the insurer
*inference* unobservable on the one page in the repo that could show it:
never-overwrite is absolute, so the panel's value would have been declined
whatever it worked out. Insurer is now empty and fills from the form, and the
guard moved to **MC days in step 2, pre-filled with 7 against the note's 14** —
deliberately disagreeing, because a pre-fill that matches what the note produces
cannot demonstrate a refusal at all. If that box reads 14 after a fill, the guard
is broken. A clinical value is also the stronger test: BreezeFill has a competing
answer for it and must still decline. `wizard_test.json` now declares
`insurer: "AIA"` — the canonical name `_normalised` writes — where it previously
said "Test" while the page said "AIA Singapore", so the fixture and its schema
were modelling two different insurers.

**The step-1 labels are exact and must not be reworded casually.**
`demographic_field_for_label` normalises to letters and strips only *patient*
qualifiers, so `Contact No.` resolves and `Contact Number` does not; likewise
`NRIC / FIN` against `NRIC / FIN Number`, and `Patient's Full Name` against
`Patient's Full Name (as in NRIC)`. The near-misses are documented at the top
of the fixture and deliberately kept out of the form — a box that silently
declines to fill is the wrong thing to put in front of a camera. It is also a
standing signal that **the alias table is narrower than the wordings real forms
use**; the ClaimEZ dump is what would say by how much.

The fixture also has a **mount/unmount toggle**, because the open question
(should a step hidden behind `display:none` be filled?) is still open —
`isFillable` checks `disabled` and `readOnly` but not visibility, and the
dumper does report `visible` correctly, so the information exists and only the
decision is missing. Answering it needs the real page, not the fixture.

**4. The AIA schema itself — now the thing that switches item 3 on.** Blocked
on the same dump. Write `step` on every field (from the `<legend>` the dumper
records) and `options` on every dropdown and yes/no group; both are inert
elsewhere and load-bearing here. An expired link renders
an error page with no fields, `submit-offline` is post-submission only, and the
portal is a JS-rendered SPA so no fetch-based tool can see its DOM.
`roboform_test_v1` and `wizard_test_v1` are the only schemas declaring
`hosts` (`roboform.com`, `localhost`), and both are `internal: true`, so on any
real insurer page the picker is the expected outcome rather than a bug.

**5. Prove a write lands in a *framework-rendered* field.** RoboForm is plain
HTML, so filling it says nothing about React's `_valueTracker` — the failure
that looks correct: right value on screen, stale value submitted.
`tests/fixtures/portal_like.html` is static too. Either add a small React page
with a controlled input, or get onto a real portal.

**6. Exercise the schema-free fallback in a browser.** Tested but never run
against a real unknown page — RoboForm is in the bank now, so it proves the
wrong branch. Any public form with labelled fields that no schema describes
will do. Watch two things tests cannot see: how many of a real page's controls
come back unlabelled, and whether `MAX_LIVE_FIELDS = 50` is anywhere near
right.

**7. Proof mode.** Outline each filled control and stamp its field id — the
port of `calibrate_overlay.py --proof`. Same reasoning as the overlay forms:
adjacent controls are usually different questions, and a misplaced value is
obvious in a render and invisible in a report.

**8. SG-region inference.** Both calls run `claude-opus-5` on the first-party
API, which is not SG-region, and workspace geo — where data sits at rest — is
US-only and fixed at workspace creation. Needs Bedrock `ap-southeast-1`, where
the region comes from the endpoint rather than a parameter.

This item used to read "before any real patient note", and **that is no longer
the rule** — the owner put real notes in scope on 2026-08-06 and the privacy
policy discloses the out-of-region transfer instead of forbidding the data. See
the guardrail. What is still true is that the disclosure names a PDPA
comparable-protection agreement that **is not in place**, so this remains the
item that would let that paragraph be rewritten rather than merely honest. Repo
fixtures stay synthetic regardless.

**9. Smaller, worth doing once the pilot has pasted real CMS exports.** The
label synonyms in `demographics.py` are a guess at what ClinicAssist emits.

~~The parser cannot find an insurer implied only by a policy prefix~~ — **done
2026-08-11, and the owner's call was to take it from the form rather than from
the note.** `assemble_claim` falls back to the schema's own `insurer` when the
record carries none. The reasoning is worth keeping, because it is the one
demographic where the form knows better than the paste: a note names its
insurer in passing if at all (`(AIA Singapore)` after the policy number) while
the schema states it outright, and the insurer that belongs on a claim form is
the one whose form it is. A note naming a different insurer than the form being
filled is answering a question nobody asked.

Two properties to preserve. It **only ever fills a blank** — a doctor who typed
an insurer has decided, and this is a fallback rather than a correction. And a
**live schema carries no `insurer`**, so on the schema-free path the box stays
blank and the doctor types one line.

**The extension never reached that fallback at all, and does now (2026-08-17).**
The paragraph above only ever described `POST /map` and the PDF path. The panel
calls `/map-redacted`, whose schema is built by `_live_schema` — which carries no
`insurer` — so `assemble_claim`'s fallback was unreachable from the extension and
the box came back blank on **every** claim, schema matched or not.

`inferInsurer` in `panel.js` closes it, and the shape matters: this was recorded
here as needing "the panel sending the best-fitting schema's insurer alongside
the page's controls, which is a change to the request shape". **It is not.**
`GET /forms` already returns each schema's `insurer`, the panel already holds the
matched schema in `state.schema`, and demographics are already filled in the
panel rather than on the server (`assemble_redacted` returns `fill_from` and no
value). Nothing new goes on the wire.

It writes into **the panel's own insurer box on detection**, not into the review
row, and that is the load-bearing choice rather than a UI nicety: a demographic
reaches the doctor already green — it skips both the model and the review confirm
— so an inferred value has to be visible and editable in the details drawer
*before* Map runs, instead of appearing for the first time as an answer nobody
was asked about. Two further refusals: it never marks the field `touched`, so a
note that names an insurer still wins; and it stands aside when `choices` is
asking the doctor which of two insurers the note meant.

The rejected alternative, so it is not re-opened: scanning the note for known
insurer names. It puts world knowledge into a module that is otherwise pure
shape, the list goes stale as insurers rename and merge, and a demographic
reaches the doctor **already green** — so a false positive is a wrong value
that bypasses both the model and the review confirm.

**10. Deferred.** Sweeping the `FORMFILL_*` environment variables to
`BREEZEFILL_*`; the naming note at the top of this file explains why it has not
happened. Coordinate-overlay fill for the three scanned forms.

### Answered, so nobody re-opens them

- **Does an action click that opens the side panel grant `activeTab`?** No.
  `setPanelBehavior({openPanelOnActionClick: true})` makes Chrome handle the
  click, so `action.onClicked` never fires. Fixed by taking `action.onClicked`
  and calling `sidePanel.open({tabId})` inside it. Do not simplify it back.
- **Does the portal's CSP block the extension?** No. A content script runs in
  an isolated world and is not governed by the page's CSP. A site cannot refuse
  the extension that way.
- **Does the wizard need `optional_host_permissions`?** No — the URL does not
  change between steps, so `activeTab` survives all four.
- **Is the extension loadable and does it fill?** Yes, Chrome 150, 2026-08-03,
  RoboForm's test page. Five fields filled, Date Of Birth correctly refused as
  ambiguous.

### Still unknown, and each fails in a way tests cannot see

- Whether an isolated-world write defeats React's `_valueTracker`.
- Whether the form is inside an **iframe** — injection is not `allFrames`, so
  it would read as a page with no controls.
- Whether controls sit in a **shadow root** — `querySelectorAll` does not
  pierce one; a *closed* root cannot be reached at all.
- Whether the controls are **real controls**. A `<div role="combobox">` or a
  rich date picker is invisible to the query, and ones that do render an
  `<input>` often ignore a written value — they want a click on an option.
  This is the likeliest shape of "the portal looks filled but submits nothing".

The first is answered by item 5; the other three by one dump.

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

---

# IMPORTANT — open system design: the cache, and handling users

**Status: discussed 2026-08-18, decided to WAIT, nothing built.** The owner
asked whether to create the Blob store and said in the same breath that a user
system was coming. The second answer changes the first, which is why neither
was built. Read this before creating any store.

## What is actually needed, in the owner's words

> when they first create an account with BreezeFill, they can input their own
> personal information (name, name of clinic etc). Because every form will
> require the doctor to fill in some of their own information, if I just ask
> for that info when they're setting up their accounts those fields will be
> automatically filled every time they fill an insurance form.

So: **a doctor profile, auto-filled onto forms.** Not logins for their own
sake, not a dashboard — the feature is "stop retyping my own name and clinic
on every claim". And the cache is to hold every form in the bank, current and
future.

## The cache

**It is a pure cache now, and it was not before.** Until the client began
carrying the schema (2026-08-18), the bank was the only home for an uploaded
form and losing it produced `unknown form_id` in the middle of a claim. That is
fixed. Nothing depends on the bank for correctness any more, and nothing should
be allowed to again — see the guardrail added that day.

**It is worth having, and the reason is the usage pattern rather than the hit
rate in general.** A doctor uploads *the same form once per patient*. A clinic
doing ten Great Eastern claims a week pays ten full derives — three Opus calls
each — for a form that should have been read once, ever. That is the case that
pays for it, and it is the dominant one.

**The hit needs BYTE-IDENTICAL files**, because the key is
`sha256(pdf)[:32]`. Within a clinic re-using one saved file that is effectively
100%. Across clinics it depends on whether both downloaded the same static file
from the insurer. A re-scanned or re-saved copy misses. If that turns out to
bite, a fuzzier fingerprint (page count + a digest of widget names or page text)
is the fix — but **do not loosen it speculatively**: a false match means mapping
a claim onto the wrong form.

**Store the schemas; think hard before storing the PDFs.** Measured across the
six curated forms:

```
6 forms:            53 KB of schema   vs   6.8 MB of PDF
1,000 banked forms: ~9 MB of schema   vs   ~1.1 GB with the PDFs   (120x)
```

`get_pdf` is read in exactly ONE place — the fallback in `_blank_form_bytes` for
when the client did not send the file — and the website always has the file. So
the PDF copy is close to dead weight today. Dropping it makes the bank small
enough to live anywhere.

**On Redis specifically.** It fits the access pattern (small keyed JSON, read on
every upload) and it is the wrong instinct here for two reasons. First, Redis is
usually priced and sized as a *cache with eviction*, and an evicted schema costs
a full re-derive — real money, not a slow request. Second, this data wants to be
durable and is tiny: 9 MB that should never be evicted is a table, not a cache
tier. **If a database is arriving for the user system, the bank is one table in
it** and you run one store instead of two. Blob earns its place only if the PDFs
are kept, which is the thing to avoid.

## The user system, and what it collides with

**Identity already exists and needs no database.** The licence token carries the
Stripe subscription id; `verify_licence` returns it on every gated request.
"Which clinic is this" is answered today.

**What does not exist is anywhere to put a profile**, and `licence.py` says in
its own docstring why that was deliberate:

> `README.md` says publicly that there is no database, and that sentence is why
> a clinician is being asked to trust this at all. A subscriber table would make
> it false.

**The public copy has to change before accounts ship, and one file is a store
review risk.** As of 2026-08-18:

| File | What it says |
|---|---|
| `frontend/public/privacy.html` | "Nothing is stored. There is **no database, no account**, and no file on disk" |
| `README.md` | Now says "zero retention **of patient data**" and documents the form bank — **updated 2026-08-18** |
| `frontend/src/Landing.tsx` | "There is no database." — and, elsewhere, the wording that survives: "No patient data stored" |

`privacy.html` says **"no account"** explicitly, and it is the document a Chrome
Web Store reviewer reads with the review in flight. **The promise worth keeping
is the patient one**, which survives both accounts and the form bank intact: a
doctor's own professional details and a blank insurer form are neither of them
patient data. The absolute version survives neither.

Recording an omission honestly: **the form bank already eroded "no database" on
2026-08-18 and the public copy was not updated at the time.** It stayed
literally true only because production runs `NullBank`. `README.md` is fixed;
`privacy.html` and `Landing.tsx` are not, and they must be before a store is
provisioned or accounts ship.

## The fork nobody has chosen yet

**The profile could live client-side** — `chrome.storage` in the extension,
`localStorage` on the site. No database, no sessions, no password reset, and the
doctor's details never leave their machine except to be typed onto a form. Every
current promise survives untouched.

The cost: it does not follow them between devices, it is lost if they clear
browser data, and it is re-entered per browser. For a single-machine clinic that
is nearly free; for a doctor moving between a clinic PC and a laptop it is an
irritation, and it rules out a dashboard permanently.

Note this would need the `chrome.storage` hard rule amended — it currently holds
the licence key and nothing else. That rule exists to keep *patient* data off
disk, and a doctor's own name is not a patient's, so the amendment is defensible
rather than a loophole. **Amend it deliberately, in that rule's own words, or
not at all.**

## The part that is safe to build first, whichever way the storage goes

**The mapping layer is storage-agnostic.** A `PractitionerRecord`, an alias
allowlist, `practitioner.<attr>` as a second deterministic source beside
`demographics.<attr>`, and `assemble_claim` copying the values in. It works
identically whether the profile ends up in Postgres or in `localStorage`.

**It is a privacy improvement, not a cost**, for exactly the reason
`_live_sources` is: marking a control practitioner-sourced *removes its question
from the mapping call*. Today "Your name (attending doctor)" is sent to the
model, comes back `missing` because no note answers it, and the doctor writes it
by hand.

**THE DANGER, AND IT IS THE WHOLE DESIGN.** Of 23 doctor-ish labels across the
five real forms, only about **6** are the doctor filling the form in:

```
Your name (attending doctor)       yours        Referring doctor                   NOT yours
Your MCR number                    yours        Patient's regular doctor           NOT yours
Attending physician                yours        Doctor who made that diagnosis     NOT yours
MCR number                         yours        Other doctor consulted beforehand  NOT yours
Clinic name and address            yours        Previous / referring doctor        NOT yours
                                                Hospital name (where admitted)     NOT yours
                                                ...12 more
```

Auto-filling "Patient's regular doctor" or "Referring doctor" with the current
doctor's name puts a **false clinical statement on a signed claim** — plausible,
and invisible in review, which is the exact failure class this product exists to
prevent and strictly worse than the blank it replaces. So the practitioner alias
table must be an **exact allowlist**, the same discipline as the patient one,
and it must refuse the other 17. AIA's own form shows the discriminator it uses:
it writes "**Your** name (attending doctor)" and "**Your** MCR number".

**Build the allowlist from labels that really appear**, not from the handful
visible in six schemas. The input wanted is the pilot's actual form set — which
fields he retypes on every claim.

## Order of work, when this is picked up

1. **Rewrite `privacy.html` and `Landing.tsx`** onto the patient-data promise.
   Cheapest, unblocks everything, and it is a store-review risk while it is
   wrong.
2. **Decide the profile's home** — client-side or a database. This is the fork;
   everything else follows it.
3. **Build the practitioner mapping layer.** Storage-agnostic, so it can be done
   in parallel with 2 and wired to whichever wins.
4. **Then the bank's storage.** One table in the user database if there is one;
   Blob with schemas only if there is not. Never both.

---

## Reference — the system design document

**https://claude.ai/code/artifact/416cfc07-d618-4779-93a0-b5f9c4d9db74**

Written 2026-08-19, traced from the source rather than from these notes: every
path a consultation note can take, which process each step runs in, and where
the trust boundaries sit. It covers the three dataflows (portal claim, PDF
claim, reading a blank form), all four Anthropic call sites, the complete list
of what persists, and the failure modes.

Private until shared. **It is a snapshot, not a live view** — it does not
update itself, so treat a disagreement between it and the code as the document
being out of date, and republish it from the same file path rather than
creating a second one.
