# BreezeFill — working notes for Claude

Product docs live in `README.md` (what it does, privacy model, how to add an
insurer form). **Read that first.** This file records decisions, current
state, and the traps — the things not derivable from the code.

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
deliberately still say `claimfill`, and both are correct: the Fly app is named
`claimfill` and `DEFAULT_API_BASE` points at `claimfill.fly.dev` — infrastructure
named before the product was, which would break if renamed. `FORMFILL_*`
environment variables also survive from the first name and have **not** been
swept; renaming them means touching every command in these docs plus anything
set on a host, so it is a deliberate not-yet rather than an oversight.

---

## Status as of 2026-08-04 (HEAD `f31242e`)

**363 tests pass**: 182 backend (1 skipped), 146 extension, 35 website.

| Piece | State |
|---|---|
| Pipeline: redact → LLM map → doctor review → PDF fill | Working. **Stateless as of 2026-08-04** — `POST /map` then `POST /forms/{id}/pdf`, no claim id, nothing held between them |
| Extension: manifest, side panel, service worker, dumper, matcher, value application, orchestrator | Built and green, 121 tests. **Runs in Chrome 150, and has filled a real form in a real browser** — RoboForm's 39-field test page, 2026-08-03, the whole path from one pasted block to values in the page. That is the first successful fill anywhere. Still not run on an insurer portal, and RoboForm is plain HTML, so the `_valueTracker` question is untouched by it |
| One paste box → demographics (`POST /parse`) | Working. Patterns only, no model — `backend/demographics.py`, 34 tests. Verified end to end against a live backend on the pilot's own note format: all seven fields, and the clinic's phone number under the signature correctly not taken |
| Second paste box: "Other notes" | Working, 5 tests. A claim form asks for things a consultation note does not hold (admission reference, ward class, billing codes). Both boxes join into **one corpus** via `pastedText()` — same parse, same redaction. Nothing reads `#paste` alone |
| `POST /map` — mapping for the extension | Working, shares `_review_rows` with the PDF path |
| Wizard support (steps + options) | **Built and green (2026-08-04), never run on a wizard.** Per-step fill guard (`locateSteps`), per-step identification, a `MutationObserver` that re-identifies when a step renders, schema-declared `options` validated server-side, and skip reasons surfaced. Degrades to the old behaviour for a schema with no `step` and no `options` — which is every schema in the bank, so **nothing in the bank exercises any of it**. See "The AIA form" |
| Bank → fallback → draft schema | Working in tests. The wizard problem below is now addressed — see "The AIA form" — Form identified by fingerprint against every schema; `POST /map-live` maps against the page's own labels when nothing fits; a successful schema-free fill hands back a draft schema to review and commit. Never run in a browser: RoboForm is in the bank, so it exercises the wrong branch |
| Single-machine assumption | **Gone.** The server is stateless as of 2026-08-04, so `--ha=false` is a cost preference and serverless is possible |
| Vercel migration | **Preview deployed and verified end to end (2026-08-05)**, project `breeze-fill/breezefill`, region `sin1`. `/health` reports 7 forms, `/forms` and the extension download answer, and `POST /map` returns real review rows from a live model call — demographics copied deterministically, an `extracted` value with its source quote, and `missing` where the note was silent. `ANTHROPIC_API_KEY` is set **Preview-scoped only**. Two things still true: **Deployment Protection is on**, so the extension cannot reach a preview URL (its `fetch` 401s and reads as "Could not reach the backend"), and `DEFAULT_API_BASE` still points at Fly. Fly is deliberately left running as the fallback |
| AIA GHS claim (24 fields) + Great Eastern GHS claim (15 fields) | Live, smoke-tested end to end with a real LLM call |
| Website: landing page + interactive demo | Working, 35 frontend tests. `#/` is a marketing landing page, `#/demo` walks one synthetic claim with no backend at all, `#/app` is the old 3-step PDF claim UI — kept and working, because the five PDF forms have no other interface |
| `GET /download/breezefill-extension.zip` | Working, 8 tests. Zipped from the source tree per request, so a download can never be older than the server serving it. `extension/` is now in the Docker image |
| Single-origin serving (FastAPI serves `frontend/dist`) | Working locally, verified |
| Fly deploy | **Live at `https://claimfill.fly.dev`**, redeployed 2026-08-03 with today's build. One machine, region `sin`, health passing. The app was never gone — the NXDOMAIN was `formfill-backend.fly.dev`, a name this project does not use; `fly.toml` says `claimfill` and always did. It **scales to zero now** (see fly.toml): first request after an idle spell is a second or two slow, not an error |
| `ANTHROPIC_API_KEY` | **Set as a Fly secret** and confirmed working — a live `POST /map` returns 200, which exercises the sweep. Not set in any local shell, so local `uvicorn` still needs it exported, or `FORMFILL_DISABLE_SWEEP=1` |
| **Demoable?** | **Yes — no terminal, no key.** `DEFAULT_API_BASE` is `https://claimfill.fly.dev`, which is live and holds the key. Load the extension, click the icon on an insurer's form, paste, Map, Fill. **Exception: the RoboForm test route still needs localhost**, because `roboform_test_v1` is `internal: true` and `FORMFILL_SHOW_INTERNAL` is deliberately unset in production — point Advanced → Backend URL at `http://localhost:8000` for that one. See "the demo failure" below for what broke the first attempt, all of which is now fixed and tested |

Note: commit `ec7c09c` is named "full deployment on fly.io" but only adds the
static mount to `main.py` — the actual deploy happened later, on 2026-07-30.
Verify deploy state with `flyctl`, not commit titles.

**`fly deploy --ha=false` — now a cost preference, not a correctness rule.**
It used to be load-bearing: Fly's default adds a second machine, and a claim
created on machine A 404'd when approve landed on machine B. With the claim
store gone (2026-08-04) any number of machines is correct. Keep passing it
while this is a pilot because one machine is cheaper and easier to reason
about — but a second one no longer breaks anything, so this is not the first
thing to suspect when something goes wrong.

### Where things live

| Path | What it is |
|---|---|
| `backend/main.py` | Every route. All stateless. `_review_rows` is the shared redact→map→assemble middle |
| `backend/redaction.py` | Three passes. Pass 1 is dictionary-based and needs the demographics **first** — this ordering is the privacy model |
| `backend/demographics.py` | One pasted block → demographic fields, **patterns only, never a model** |
| `backend/mapping.py` | The structured-output call, `FormSchema`/`FormField`, claim assembly |
| `backend/schemas/*.json` | The form bank. `fill_mode` is `acroform`, `overlay` or `web` |
| `extension/panel/` | The doctor's surface. Holds the claim in memory; no storage permission exists |
| `extension/learn/dump.js` | Label resolution + the scrubber. Used by both learn mode and the filler |
| `extension/fill/locate.js` | Joins schema fields to live controls by label. Also what identifies a form |
| `extension/fill/apply.js` | Writes values. Idempotent. Never submits |
| `extension/content/fill.js` | The only code that touches the insurer's page |
| `frontend/src/` | `Landing.tsx`, `Demo.tsx` (talks to nothing), `ClaimApp.tsx` at `#/app` |
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

**All three fixes are now built and tested (2026-08-04), and none of them has
met the form they were written for.** They are mechanism, not configuration:
each one degrades to exactly the old behaviour when a schema declares no steps
and no options, which is every schema in the bank today. So the risk is not
that they break what works — the suites cover that — it is that the mechanism
answers a differently-shaped problem than the real ClaimEZ turns out to pose.
Read the fixes below as *implemented*, and the facts they rest on as still
verbal. **The dump remains next steps item 1 and is what would confirm any of
this.**

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

**Hosting is being revisited (2026-08-04), and the statelessness above is what
unblocks it.** The original single-origin decision assumed the website *was*
the product; it is not any more, so the website (static: landing, demo,
pricing) and the API (Python, needs the key, needs a region) no longer have to
share a host. Two options are open, both now viable:

- **Website on Vercel, API on Fly.** Lowest risk, and the wiring already
  exists — `VITE_API_URL` and `FORMFILL_ALLOWED_ORIGINS` were deliberately
  left in place. Buys: no cold start on the marketing site, and the download
  page stays up when the API is down (it went down with it for ten minutes on
  2026-08-03).
- **Everything on Vercel.** Possible only because the API is stateless now —
  serverless gives no sticky instance, so the old claim store would have 404'd
  every approve.

**Chosen 2026-08-04: everything on Vercel, Fly kept as a fallback.** Prepared
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
  413 on Vercel and be fine on Fly. Check the size when adding an overlay form.
- **Hobby forbids commercial use**, and Vercel counts "advertising the sale of
  a product or service" as commercial — donations too. **The pricing page the
  owner plans puts this over the line**, and it does so on any hosting shape,
  because the marketing site is what carries it. Pro is $20/month. Today, as a
  free pilot with no pricing page, Hobby is legitimate.

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

**Doctors confirm, they don't just read.** Anything not directly `extracted`
requires an explicit confirm click before the PDF can be generated. Editing a
value counts as confirming it. Do not "helpfully" pre-confirm inferred fields.

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
local agent or browser extension — never the Fly server holding standing
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

Redaction stays server-side for now. Running it in the extension would mean
demographics never leave the browser at all, which is strictly better — but it
means `redaction.py` in two languages with two test suites, and any drift
between them is a leak. That is a hardening task, not part of the pivot.

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

No `chrome.storage` anywhere, and the permission is not requested: patient
notes must not reach disk. This is also why `background.js` is nearly empty —
a service worker acting as a message broker is evicted after ~30s idle, so it
would have to persist the note to survive. State lives in the panel.

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

3. **A successful schema-free fill hands back a draft schema** for a human to
   read and commit. Not installed, not auto-committed, not PR'd — the owner's
   call, and the right one: a schema is used on every later claim against that
   form, so an unreviewed one turns a single mis-mapped field into a permanent
   wrong answer that nothing ever re-checks. The draft appears while the page
   that produced it is still on screen, which is the only moment anyone can
   check the labels against the form they are looking at.

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

**Duplicate PDF field names across pages.** Names like `Policy No` and
`Company Name` repeat on pages 2 and 3 of the AIA form. When adding fields,
verify the page and rect, not just the name.

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
  finding them**: `POST /parse` splits the paste with patterns and no model,
  because a model that split it would have read the name before the dictionary
  that redacts the name existed. Do not "improve" the parser by handing the
  block to Claude when a field comes back blank — a blank field is a doctor
  typing one line.
- **The server is stateless. Every route.** The token→value map lives only for
  the duration of one request, and there is no claim store, session or id
  behind any endpoint. Do not add one — a shared store would be a database
  holding patient data, which this product says publicly it does not have, and
  it would restore the two-machine trap that `--ha=false` used to guard.
- **A drafted schema is a proposal, never an installation.** `/map-live`
  returns rows; the panel renders JSON; a human commits it. Do not add a route
  that writes a schema to disk from a running claim — the schema then governs
  every later claim on that form and nothing would ever re-read it. This was
  decided with the alternatives on the table (auto-PR, auto-write).
- **No `chrome.storage`, and the permission is not requested.** Patient notes
  must not reach disk. The claim lives in the side panel's memory while the
  doctor has it open; closing the panel discards it. Any future need to
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
- **An off-list answer is `missing`, never the nearest option.** When a field
  declares `options`, case and whitespace are forgiven and nothing else. Do not
  add fuzzy matching to raise the fill rate — the value is a clinical statement
  the doctor signs, and a near-miss snapped across by string distance is
  indistinguishable in review from an answer the notes supported.
- No patient data in logs or error messages. LLM failures return a generic
  `"LLM call failed"`.
- **No real patient data until inference is confirmed in-region.** Both calls
  run `claude-opus-5` on the first-party API, which is not SG-region.
  **`inference_geo` cannot solve this** — verified against the docs, it accepts
  only `"us"` and `"global"`; there is no Singapore value, and workspace geo is
  US-only too. It is wired up behind `FORMFILL_INFERENCE_GEO` (unset by
  default) for whenever more geos land. Real SG-region inference needs
  **Amazon Bedrock `ap-southeast-1`**, where the region comes from the endpoint
  rather than a parameter — that means the `AnthropicBedrockMantle` client and
  `anthropic.`-prefixed model ids. Synthetic or anonymised notes until then.
- The API key belongs in a Fly secret, never in a repo file, and never pasted
  into a chat transcript (including via the `!` prefix, which is logged).
- Repo fixtures are synthetic only.
- A learn-mode dump is an LLM input. It may be shared only after it has been
  read — the guarantee is structure-only by construction, but the residual
  risks in `extension/README.md` are real. Never send the URL, a screenshot, or
  the raw DOM alongside it.

---

## Commands

```bash
# tests (offline, no API key needed)
./.venv/Scripts/python.exe -m pytest -q

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
./.venv/Scripts/python.exe -m uvicorn main:app --app-dir backend --port 8000

# ...except for the RoboForm route, which needs NO key at all. Its schema is
# all-demographics, so map_fields never calls the model; disabling the sweep
# removes the only other call. FORMFILL_SHOW_INTERNAL puts the test schema in
# the picker, which is the only way the panel can name it.
export FORMFILL_SHOW_INTERNAL=1 FORMFILL_DISABLE_SWEEP=1
./.venv/Scripts/python.exe -m uvicorn main:app --app-dir backend --port 8000
# then: https://www.roboform.com/filling-test-all-fields, click the BreezeFill
# icon ON THAT TAB, paste a case from docs/test_notes.md, Map, Fill.

# frontend dev (expects backend on :8000)
cd frontend && npm run dev            # http://localhost:5173

# production shape locally: build the frontend, then hit the backend alone
cd frontend && npm run build          # backend then serves it at /
./.venv/Scripts/python.exe -m uvicorn main:app --app-dir backend --port 8100

# dump a PDF's field names when adding a form
./.venv/Scripts/python.exe backend/pdf_fill.py forms/your_form.pdf

# Vercel. Login and `env add` need a real terminal; everything else runs from
# here once ~/.vercel auth and .vercel/project.json exist — same shape as
# flyctl. `vercel env ls` prints names and "Encrypted", never values.
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

**`flyctl` is installed at `~/.fly/bin/flyctl.exe`** (reinstalled 2026-08-03
with `iwr https://fly.io/install.ps1 -useb | iex`, after being found missing —
its absence fit the app having been destroyed rather than stopped). `~\.fly\bin`
is on the persistent user PATH, so a **new** terminal finds it; one opened
before the install will not.

**The command is `flyctl`, not `fly`.** The Windows installer ships
`flyctl.exe` and no `fly.exe`, so every `fly ...` line in Fly's own docs is a
command-not-found here, and it reads exactly like a PATH problem that reopening
the terminal should fix. It is not.

**`flyctl auth login` cannot be run through Claude Code.** It needs an
interactive terminal, and both the PowerShell tool and the `!` prefix run
non-interactively with stdin on the null device — it exits 1 with "requires an
interactive terminal" rather than hanging. It must be a real terminal window
the owner opens themselves. This is one-time: the token lands in
`~/.fly/config.yml`, and every later command (`apps list`, `secrets list`,
`deploy`) is non-interactive and can be run from here. Quote the path when
invoking it directly — the profile directory has a space in it.

The `!` prefix in Claude Code runs **Bash**, not PowerShell.

**Toolchain quirks that cost a session to work out.** On the OneDrive-synced
copy, `node`/`npm` are installed but invisible to both the Bash tool and
PowerShell's `Get-Command` — reach them through `cmd /c "npm test"`. And
`.venv` was created under a different Windows user profile, so
`.venv/Scripts/python.exe` resolves to a path that does not exist
(`C:\Users\thnge\...`); recreate the venv on any machine where that happens
rather than assuming Python is missing. Check both before concluding a suite
cannot be run.

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

**2. Finish the Vercel migration — preview is done, three things remain.**
Linked, deployed and verified on 2026-08-05 (see the status table). The build
command and `public/` both turned out fine; what actually broke was three
things nobody would have predicted, now in Traps. What is left:

- **Turn off Deployment Protection for previews, or issue a bypass token.**
  This is the blocker on ever driving the *extension* against Vercel: a
  protected preview 401s the panel's `fetch`, which surfaces as "Could not
  reach the backend" and looks like a backend fault.
- **Add `ANTHROPIC_API_KEY` for Production** (`vercel env add
  ANTHROPIC_API_KEY production`). It is Preview-scoped today, so production
  `/map` 503s until this lands *and* a deploy follows — an env change does not
  reach a function that is already deployed.
- **Point `DEFAULT_API_BASE` at the new domain, and leave Fly running a week.**
  Only after the extension has actually filled something against Vercel.

Owner's terminal for anything holding the key — a key pasted into a transcript
is a key to rotate.

**3. ~~Wizard support~~ — built 2026-08-04, now waiting on the dump to be
verified.** All three problems are addressed in code and covered by tests; see
"The AIA form" above for what each fix does and what it deliberately does not
do. What remains is not implementation: it is that no schema declares a `step`
or an `options` list, so **none of it runs on anything today**. The first
ClaimEZ schema is what turns it on, and one open question (should a step hidden
rather than unmounted be filled?) is recorded there for the dump to answer.

**4. The AIA schema itself — now the thing that switches item 3 on.** Blocked
on the same dump. Write `step` on every field (from the `<legend>` the dumper
records) and `options` on every dropdown and yes/no group; both are inert
elsewhere and load-bearing here. An expired link renders
an error page with no fields, `submit-offline` is post-submission only, and the
portal is a JS-rendered SPA so no fetch-based tool can see its DOM.
`roboform_test_v1` is still the only schema declaring `hosts`, so on any
insurer page the picker is the expected outcome rather than a bug.

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

**8. SG-region inference, before any real patient note.** Both calls run
`claude-opus-5` on the first-party API, which is not SG-region. Needs Bedrock
`ap-southeast-1`. Until then: synthetic notes only.

**9. Smaller, worth doing once the pilot has pasted real CMS exports.** The
label synonyms in `demographics.py` are a guess at what ClinicAssist emits, and
the parser cannot find an insurer implied only by a policy prefix (`GHS-`,
`GE-`, `PRU-`) — deriving it from the selected schema's `insurer` would be
deterministic and is probably right.

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
