# ClaimFill browser extension

Insurers increasingly do not send a PDF. AIA's ClaimEZ mails the doctor a
tokenised link (`https://claimez.aia.com.sg/doc/?pid=<uuid>`) to an HTML form
that is filled and submitted in the browser. A filled PDF is the wrong artefact
for that channel, and asking a doctor to print, hand-fill and scan is more
friction than the whole product removes.

So this directory holds the third fill target, alongside `acroform` and
`overlay`: fill the insurer's own web form in place. As of 2026-08-03 it is
also **the product's main surface** — the doctor pastes the note into this
extension's side panel rather than into a separate website.

**Current state: complete enough to load, never run in a browser.** 83 tests
pass against jsdom and a synthetic fixture, which proves the logic and says
nothing about the fit.

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
| `panel/` | The doctor's surface: patient + note → `POST /map` → review → fill. Holds the claim in memory. |
| `content/fill.js` | Injected on gesture. Wires dump → locate → apply. The only code that touches the insurer's page. |
| `learn/dump.js` | Learn mode, plus the control collection and label scrubbing the filler reuses. |
| `fill/locate.js` | Joins schema fields to live controls by label. Refuses when ambiguous. |
| `fill/apply.js` | Writes values past a framework's value tracker. Never submits. |

### What it can reach, and when

Nothing, until the doctor clicks the ClaimFill toolbar icon on the tab they
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
claimfillLearn.dump()

// copy it out:
copy(JSON.stringify(claimfillLearn.dump(), null, 2))
```

Paste the contents of `learn/dump.js` into the console first. It attaches
itself to `globalThis` and touches nothing else on the page.

A wizard only has its current step in the DOM, so capture each step and
combine:

```js
const steps = [];
steps.push(claimfillLearn.dump());   // run again after each "Next"
copy(JSON.stringify(claimfillLearn.mergeDumps(steps), null, 2));
```

### Reading the output

| Field | Meaning |
|---|---|
| `label` / `labelSource` | The question text, and how it was found. `aria-label`, `label[for]` and `wrapping-label` are real associations; `preceding-sibling` and `placeholder` are guesses and should be checked by eye. |
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
- `preceding-sibling` labels are page text adjacent to a control. Scrubbed, but
  not covered by the prose ban.
- `scrubbedStrings` undercounts: it only sees shaped identifiers.

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
- **`fill_mode: "web"` in `FormSchema`**, so a web target is a first-class
  schema kind rather than a plan assembled in the panel.
- **An AIA ClaimEZ schema**, blocked on a learn-mode dump from a live page.

## Assumptions that jsdom cannot test

Every one of these fails silently or misleadingly on a real portal:

- **Does opening the side panel via the action click grant `activeTab`?** If
  not, `executeScript` throws and the panel shows its "click the ClaimFill
  icon" message forever.
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
