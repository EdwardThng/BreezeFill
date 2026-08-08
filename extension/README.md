# BreezeFill browser extension

Insurers increasingly do not send a PDF. AIA's ClaimEZ mails the doctor a
tokenised link (`https://claimez.aia.com.sg/doc/?pid=<uuid>`) to an HTML form
that is filled and submitted in the browser. A filled PDF is the wrong artefact
for that channel, and asking a doctor to print, hand-fill and scan is more
friction than the whole product removes.

So this directory holds the third fill target, alongside `acroform` and
`overlay`: fill the insurer's own web form in place. As of 2026-08-03 it is
also **the product's main surface** — the doctor pastes the note into this
extension's side panel rather than into a separate website.

**Current state: loads and runs in Chrome 150, and has filled a real form in a
real browser** — RoboForm's 39-field test page on 2026-08-03, the whole path
from one pasted block to values in the page. No insurer portal yet, and
RoboForm is plain HTML, so nothing there says anything about a
framework-rendered field.

242 tests pass against jsdom and a synthetic fixture. Running it in a browser
has already found several things the suite could not — see the table in
`../CLAUDE.md` — so read a green suite as "the logic holds", never as
readiness.

There is now a route that can be run end to end **without an `ANTHROPIC_API_KEY`**:
`roboform_test_v1` targets RoboForm's public 39-field test page and is
all-demographics, so no model is called at any point.

```bash
FORMFILL_SHOW_INTERNAL=1 FORMFILL_DISABLE_SWEEP=1 \
  .venv/bin/python -m uvicorn main:app --app-dir backend --port 8000
```

Then open <https://www.roboform.com/filling-test-all-fields>, click the
BreezeFill icon **on that tab**, paste a case from `docs/test_notes.md`, and
Map. Five fields fill; Date Of Birth is reported ambiguous, because three
`<select>`s there share that one label and picking one of them would be a
guess.

---

## Installing it

```
chrome://extensions -> Developer mode -> Load unpacked -> select extension/
```

Reload the extension after every change. The side panel needs reopening, and
an already-injected insurer tab needs reloading too.

By default the panel talks to the deployed backend. Point it at a local one
under **Advanced → Backend URL** (in-memory for the session; the extension
requests no storage permission, so there is nowhere to persist it).

## How it fits together

| File | Role |
|---|---|
| `manifest.json` | MV3. No content scripts, no default host permissions, no `tabs`, no `storage`. Declares `icons` and `action.default_icon` from `icons/`. |
| `icons/` | Generated — see `assets/logo/`, never hand-edited. The toolbar icon is the doctor's access grant, not decoration. |
| `background.js` | Opens the side panel on action click. Nothing else, deliberately. |
| `panel/` | The doctor's surface: name → note → other notes → check details → review → fill, one step at a time. Holds the claim in memory. `STEPS` and `showStep()` move visibility only — every input stays in the DOM, so stepping back loses nothing and the panel can still be driven directly. Design: `docs/design/breezefill-panel/`. |
| `content/fill.js` | Injected on gesture. Wires dump → locate → apply. The only code that touches the insurer's page. |
| `learn/dump.js` | Learn mode, plus the control collection and label scrubbing the filler reuses. |
| `fill/locate.js` | Joins schema fields to live controls by label. Refuses when ambiguous. Also what identifies a form: the same measurement, read at a looser threshold. |
| `fill/apply.js` | Writes values past a framework's value tracker. Never overwrites an answer already in a control, never puts the same option in two instances of one repeating question, never clicks a page button, never submits. |

### What it can reach, and when

Nothing, until the doctor clicks the BreezeFill toolbar icon on the tab they
want filled. That grants `activeTab` for that tab and that visit.

The `tabs` permission is **not** requested, so the panel cannot read any tab's
address — it learns the host from the injected script's own `location.host`,
after the doctor put that script there. The visible cost is that opening the
panel on one tab and then switching to another means clicking the icon again.
That is the grant working, not a bug.

`chrome.storage` is not requested either. The claim lives in the panel's
memory while it is open and nowhere else, so a clinical note cannot reach disk
by mistake. This is also why `background.js` stays empty of state: an MV3
service worker is evicted after ~30s idle, so anything it had to remember
would have to be persisted.

### Which form is this — and why it no longer decides anything

**The bank stopped being a gate on 2026-08-05.** The doctor has to submit the
form on their screen whatever this repository knows about it, so "is this in
the bank" can only change *how well each question is answered*, never whether
they are attempted. There is no picker to get past, no fallback to opt into,
and no state in which the panel looks at a form and declines to fill it.

**One path.** Every fillable control on the page becomes a question to map.
`locate.enrich` joins each control to the schema field that describes it, if
one does, and that field lends its `description` — the instruction you would
give a colleague ("the date the patient FIRST consulted this doctor for this
condition, not the latest visit") rather than the question as the page happens
to word it. A control nothing describes is still filled, from its own label.
Weaker, and reported as such, but a blank the product could have answered is a
worse outcome than a weaker instruction.

Two properties of the join worth keeping:

- **A described control travels under the schema's wording, not the page's.**
  This is a privacy property, not a cosmetic one: on a page the bank fully
  describes, what leaves the browser is exactly what the old schema-only route
  sent. Only questions nothing describes carry their own labels out, which is
  the irreducible cost of answering them at all. The join runs *in the page*,
  so instructions reach controls without page structure being sent anywhere to
  arrange it.
- **A weak or ambiguous match attaches nothing.** Same `MIN_SCORE` and tie
  margin that filling uses. Attaching the wrong description is worse than
  attaching none — it would confidently tell the model to answer a different
  question than the one on screen, and unlike a mislocated value there is
  nothing on the page to make that visible in review.

**The limit, found by a test that expected to pass.** Matching compares words,
not meaning. "7. When did the patient first consult you" and "Date of first
consultation" are the same question, share one content token, score 0.22, and
do not match. It fails safely — the control is still filled from its own
label — but it means **a web schema wants labels authored from the page's own
wording**, which is what the draft-schema flow produces, rather than from the
labels of the equivalent PDF form. Do not assume `aia_ghs_claim`'s labels will
enrich the ClaimEZ page; they were written for a PDF.

Identification still runs, quietly, to pick which schema does the enriching.
It scores each schema by its best-fitting single step at looser thresholds than
filling (`IDENTIFY_MIN_RATE` 0.4 vs `MIN_MATCH_RATE` 0.7), because a wizard
shows one step at a time. A host in `hosts` narrows the shortlist but does not
settle it — one insurer serves several forms from one domain. The picker
survives as a manual override for a doctor who knows the bank describes their
form better than the page does.

**Everything goes through `POST /map-live`**, which now carries both kinds of
field in one request. It needs an `ANTHROPIC_API_KEY` — unlike the RoboForm
route above, these fields are `source: "llm"`.

**A successful fill of a form nothing described hands back a draft schema.** JSON in the
panel, for you to read and commit into `backend/schemas/`. It is not installed
and not committed automatically, and that is deliberate: a schema governs every
later claim against that form, so an unreviewed one turns one mis-mapped field
into a permanent wrong answer nothing re-checks. Two things to fix by hand
every time — `display_name` (guessed from the host, and it says so) and the
`description`s, which start as the labels and are where a schema earns its
keep.

`hosts` in a draft is the **full host**, not a guessed registrable domain: the
last two labels of `claimez.aia.com.sg` are `com.sg`, and host matching covers
subdomains, so that draft would have claimed every commercial site in
Singapore. Widen it by hand if you want the whole domain.

### Wizards: one step in the DOM at a time

Built 2026-08-04, and **never yet run on a wizard** — no schema declares a step,
so every form in the bank takes the single-step path below unchanged.

A schema field can carry a `step`. When one does, three things change:

- **The fill guard is evaluated per step, not per plan.** A plan spanning
  admission details and diagnosis finds about half its fields on either step,
  which is under `MIN_MATCH_RATE` — so the old behaviour was to write nothing,
  on the correct form. Each step is now scored on its own, and every step that
  clears the guard *by itself* is taken to be on screen. Their fields are then
  located in one pass, so two steps cannot both claim the same control.
- **Identification is scored per step too.** A four-step schema judged on its
  whole field list looks mostly absent on any one step, and would lose to a
  small unrelated schema sharing three labels.
- **The page is watched for a step rendering.** A ClaimEZ step change is not a
  navigation — the URL is fixed until the final step — so a `MutationObserver`
  in `content/fill.js` reports when the page's shape settles into something
  different, and the panel re-identifies.

`MIN_MATCH_RATE` and `MIN_MATCHED` are **unchanged**, and a step must clear both
alone. The fix is asking the guard a better question, not a softer one.

Two things it will not do, both deliberate: it never fills on its own (the
observer re-identifies and offers; the doctor still clicks), and it never
overrules a form the doctor picked by hand.

### A field that declares its options

`options` on a schema field lists the answers the control accepts, worded
exactly as the form words them. The model is shown the list, and an answer that
is not on it is downgraded to `missing` on the server rather than carried
forward — which is what stops "Ward B1" against an option reading
"B1 (4-bedded)" from passing review and then silently filling nothing.

Matching forgives case and surrounding whitespace and nothing else. It does not
snap to the nearest option, and that is not a gap to close: the value is a
clinical statement the doctor signs, and a near-miss corrected by string
distance looks exactly like an answer the notes supported.

### Refusals worth knowing before you debug

- **Below `MIN_MATCH_RATE`, the filler writes nothing at all** rather than
  filling the part that still matches. A partial fill is indistinguishable
  from a complete one to someone reviewing quickly. A panel reporting "only
  matched 3 of 9" is working as designed.
- **A live control no schema field claims is still filled**, from its own
  label, and reported as undescribed. This is the 2026-08-05 change: it used
  to be left blank and listed back to the doctor. That list is still the input
  to extending the schema — it is just no longer a blank on the form.
- **A page whose questions cannot be read is refused with a reason.** No
  labelled fields comes back `422`, more questions than one call can carry
  comes back `413`, and the panel turns each into a sentence. Both used to
  surface as a bare "Request failed (422)", which a tester hit and could do
  nothing with.

---

## Learn mode

The web-portal analogue of `python backend/pdf_fill.py forms/your_form.pdf` —
it reports what fields a form *has* so a schema can be written against them.

```js
// DevTools console, on the form page:
breezefillLearn.dump()

// copy it out:
copy(JSON.stringify(breezefillLearn.dump(), null, 2))
```

Paste the contents of `learn/dump.js` into the console first. It attaches
itself to `globalThis` and touches nothing else on the page.

A wizard only has its current step in the DOM, so capture each step and
combine:

```js
const steps = [];
steps.push(breezefillLearn.dump());   // run again after each "Next"
copy(JSON.stringify(breezefillLearn.mergeDumps(steps), null, 2));
```

### Reading the output

| Field | Meaning |
|---|---|
| `label` / `labelSource` | The question text, and how it was found. `aria-label`, `label[for]` and `wrapping-label` are real associations; `table-cell`, `preceding-sibling`, `ancestor-sibling` and `placeholder` are proximity guesses and should be checked by eye. |
| `selector` | Fallback match key. Weaker than `label` on purpose — framework builds regenerate ids and class names, but insurers rarely reword a regulated question. |
| `options` | Enumerations. `withheld: true` means the list looked like claim data, not choices, and only the count survives. |
| `maxLength` | Silent truncation risk. The web equivalent of the `/MaxLen` comb-field trap in `pdf_fill.py`. |
| `visible` | False for a step that is present but not displayed. Absent entirely for a step not in the DOM. |
| `hasValue` | Whether the control was populated. **The only thing the dump says about content.** |
| `instance` | Which repeating entry the control sits in, 1-based, or `null`. Derived from DOM shape — the nearest ancestor whose siblings hold the same controls in the same order, and which holds two or more of them. **Never from the sub-heading that names the entry on screen**: a heading is a name-bearing surface and `NEVER_A_LABEL` forbids reading one. `null` until a second entry exists, because one entry needs no disambiguation. |
| `scrubbedStrings` | How many pieces of page chrome held a shaped identifier. Nothing from them is emitted; it is a warning that this page is PHI-bearing. |

---

## The content boundary

**A dump gets pasted into a model to draft a schema. That makes a dump an LLM
input, held to LLM input rules.** An insurer claim page arrives pre-populated —
name, NRIC, policy number are in the DOM before the doctor opens the link — so
the naive version of this tool (dump the DOM, hand it to Claude) would route
PHI around `backend/redaction.py` entirely.

What the dumper guarantees:

- No control's value is ever read. `hasValue` is a boolean.
- Repeating entries are numbered from structure, not from their headings. The
  sub-header is the obvious key and is precisely the surface the heading ban
  exists for — `dump.test.js` plants a name in one and asserts it never
  reaches a dump.
- Every emitted string goes through `scrub()`: NRIC/FIN, SG phone, email, and
  long digit runs, mirroring pass 2 of `redaction.py`.
- `type="password"` is skipped and never inventoried; `type="hidden"` is
  skipped, which is what keeps the `?pid=` claim token out.
- Only the **host** is recorded, never the URL. `?pid=` is a bearer credential
  for one patient's claim.
- Section and step text come from `<legend>` only — never `<h1>`, `<h2>` or
  loose prose.

That last one is the non-obvious rule, and it is worth stating why. The
scrubber finds identifiers **by shape**. A name has no shape: `Tan Wei Ming` is
indistinguishable from `Tan Tock Seng` by regex. `redaction.py` only handles
names because pass 1 has the demographics dictionary to match against — the
doctor typed the patient in. Learn mode has no dictionary. So for name-bearing
surfaces the only safe rule is to not read them, and a claim page heading that
reads "Claim for &lt;patient&gt; (&lt;NRIC&gt;)" is exactly such a surface.

The same reasoning drives option withholding: if scrubbing changes *any* option
in a list, the whole list is withheld. A policy picker reading
`80123456 — Tan Wei Ming — GHS` has a shaped number sitting next to an
unshaped name, so partial scrubbing would emit the name. Withholding the list
whole is what catches it.

### Residual risks — read before running on a live claim

- A list of bare names with no number or NRIC beside them would pass. Nothing
  here detects that.
- `preceding-sibling` and `ancestor-sibling` labels are page text near a
  control. Scrubbed, but by proximity rather than by association, so they are
  the two sources a schema author should read before trusting.
- `scrubbedStrings` undercounts: it only sees shaped identifiers.

`ancestor-sibling` is the newest of these and the one that widens the surface,
so it is bounded deliberately: two hops, never past the control's own form or
fieldset, never a heading or a paragraph, never a node containing another
control, nothing over 200 characters. It exists because without it a whole
page can read as unlabelled — 36 of RoboForm's 39 controls did — and that
failure is invisible: every label scores 0, nothing matches, and the filler
refuses a page it could have filled.

**Prefer a test or expired link.** Where that is not possible, read the dump
before it goes anywhere — it is a few hundred lines of JSON and eyeballing it
is cheap. Never share the raw DOM, a screenshot, or the URL alongside it.

---

## Tests

```bash
npm install       # from the repo root, not frontend/
npm test
```

Separate from `pytest` and from `frontend/package.json` on purpose: the
extension is not part of the served bundle, and the Dockerfile copies only
`backend/`, `frontend/` and `forms/`.

`tests/fixtures/portal_like.html` is a synthetic ClaimEZ-shaped page with
identifiers planted along all three leak routes — control values, a heading,
and select options. The lead test asserts none of them reach a dump, the same
way `tests/test_redaction_corpus.py` guards clinical text. **If you add an
identifier to the fixture, add it to `PLANTED_IDENTIFIERS` too** — the test is
only as good as that list.

---

## Not built yet

- **Proof mode** — outline each filled control and stamp its field id, the
  port of `scripts/calibrate_overlay.py --proof`. Adjacent controls are
  usually different questions, so a value under the wrong heading is obvious
  in a render and invisible in a report.
- **An AIA ClaimEZ schema**, blocked on a learn-mode dump from a live page.
  This is also what would switch wizard support on: `step` and `options` are
  schema fields, and no schema sets either today.
- **A run against a real unknown page.** The undescribed-control path is
  tested, but RoboForm is in the bank, so it exercises the described branch.
  Watch two things a test cannot see: how many of a real page's controls come
  back unlabelled, and whether `MAX_LIVE_FIELDS = 50` is anywhere near right
  now that *every* control is mapped rather than only the unclaimed ones.
- **A store listing.** Distribution is the live blocker: a zip plus Developer
  Mode is not something a GP will do, and Chrome blocks self-hosted `.crx`
  outside enterprise policy. Icons are done; a privacy policy, listing assets,
  and dropping the never-requested `optional_host_permissions` are not. See
  next steps in `../CLAUDE.md`.

## Assumptions that jsdom cannot test

Every one of these fails silently or misleadingly on a real portal:

- ~~Does label resolution find anything on a real page?~~ **Answered on
  RoboForm: it did not.** 36 of 39 controls resolved to an empty label, which
  scores 0 against every schema field, so the page could not have been filled
  by any schema. The fixture used `<label for>` and tables throughout and could
  not see it. Fixed by rule 6; the fixture now carries a grid row too.

- ~~Does opening the side panel via the action click grant `activeTab`?~~
  **Answered on Chrome 150: no.** With
  `setPanelBehavior({openPanelOnActionClick: true})` Chrome handles the click
  itself, `action.onClicked` never fires, and the click does not count as
  invoking the extension — the panel opens and then cannot reach the tab it is
  sitting beside. `background.js` now takes `action.onClicked` and calls
  `sidePanel.open({tabId})` from inside it. Do not collapse that back into the
  one-liner; it looks like a needless detour until you hit this.
- **Does an isolated-world write actually defeat React's `_valueTracker`?**
  Content scripts get their own DOM wrappers, so the instance-level accessor
  React installed in the main world may not even be visible from here — which
  would make `fill/apply.js`'s prototype-setter trick belt-and-braces rather
  than load-bearing. Either way it stays; only a real portal says which.
- **Is the form inside an iframe?** Injection is not `allFrames`, so it would
  read as a page with no controls and refuse to fill. That is the safe
  direction to fail, but fixing it needs a decision on how per-frame reports
  merge and which frame the match rate is computed over.
- **Fill must never submit.** The doctor clicks submit and signs, unchanged.
  Asserted in `fill/apply.test.js` and `content/fill.test.js`, but worth
  re-checking by eye the first time it runs on a real page.
