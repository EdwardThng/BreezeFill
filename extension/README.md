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

121 tests pass against jsdom and a synthetic fixture. Running it in a browser
has already found several things the suite could not — see the table in
`../CLAUDE.md` — so read a green suite as "the logic holds", never as
readiness.

There is now a route that can be run end to end **without an `ANTHROPIC_API_KEY`**:
`roboform_test_v1` targets RoboForm's public 39-field test page and is
all-demographics, so no model is called at any point.

```bash
FORMFILL_SHOW_INTERNAL=1 FORMFILL_DISABLE_SWEEP=1 \
  ./.venv/Scripts/python.exe -m uvicorn main:app --app-dir backend --port 8000
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
| `manifest.json` | MV3. No content scripts, no default host permissions, no `tabs`, no `storage`. |
| `background.js` | Opens the side panel on action click. Nothing else, deliberately. |
| `panel/` | The doctor's surface: one pasted block → `POST /parse` → `POST /map` → review → fill. Holds the claim in memory. |
| `content/fill.js` | Injected on gesture. Wires dump → locate → apply. The only code that touches the insurer's page. |
| `learn/dump.js` | Learn mode, plus the control collection and label scrubbing the filler reuses. |
| `fill/locate.js` | Joins schema fields to live controls by label. Refuses when ambiguous. Also what identifies a form: the same measurement, read at a looser threshold. |
| `fill/apply.js` | Writes values past a framework's value tracker. Never submits. |

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

### Which form is this, and what if we don't have it

Three steps, in order.

**1. The bank.** Every schema is scored against the live controls and the best
fit wins. This asks "does this page carry the fields this schema describes",
which is what matters, rather than reading a form id out of the markup, which
rots at the insurer's next deploy. A host in a schema's `hosts` narrows the
shortlist first but does not settle it — one insurer serves several forms from
one domain. Two schemas fitting equally well is not a winner; that falls back
to the picker.

Identification uses looser thresholds than filling (`IDENTIFY_MIN_RATE` 0.4 vs
`MIN_MATCH_RATE` 0.7). A wizard shows one step at a time, so the right schema
may only find a third of its fields on the page in front of you. That is safe
because identifying is not deciding: whatever is picked still has to clear the
fill guards before a value is written.

**2. No schema? Map against the page.** `POST /map-live` takes the page's own
labels instead of a schema's fields. Same redaction, same review, same confirm
before anything is written. Offered only when nothing fits, and never the
default, because it is **strictly weaker** — a schema's `description` is the
instruction you would give a colleague ("the date the patient FIRST consulted
this doctor for this condition, not the latest visit"), and a page can only
supply the question as it is worded.

It also has a cost the schema path does not: **page structure becomes an LLM
input on every claim mapped this way.** Labels are scrubbed twice, in the
browser and again server-side, and that still cannot catch a name.

Note this path *does* need an `ANTHROPIC_API_KEY` — unlike the RoboForm route
above, its fields are all `source: "llm"`.

**3. A successful schema-free fill hands back a draft schema.** JSON in the
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

### Two refusals worth knowing before you debug

- **Below `MIN_MATCH_RATE`, the filler writes nothing at all** rather than
  filling the part that still matches. A partial fill is indistinguishable
  from a complete one to someone reviewing quickly. A panel reporting "only
  matched 3 of 9" is working as designed.
- **A live control no schema field claims is left blank** and listed back to
  the doctor as theirs to fill. That list is also the input to extending the
  schema.

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
- **A `MutationObserver` re-run** as wizard steps render. This is what the
  declared-but-unrequested `optional_host_permissions` is for: access that
  survives a step change.
- **An AIA ClaimEZ schema**, blocked on a learn-mode dump from a live page.
- **A run of the schema-free fallback against a real unknown page.** It is
  tested, but RoboForm is in the bank now, so it exercises the wrong branch.

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
