# ClaimFill browser extension

Insurers increasingly do not send a PDF. AIA's ClaimEZ mails the doctor a
tokenised link (`https://claimez.aia.com.sg/doc/?pid=<uuid>`) to an HTML form
that is filled and submitted in the browser. A filled PDF is the wrong artefact
for that channel, and asking a doctor to print, hand-fill and scan is more
friction than the whole product removes.

So this directory holds the third fill target, alongside `acroform` and
`overlay`: fill the insurer's own web form in place.

**Current state: learn mode only.** The dumper below exists so a form schema
can be written. Nothing here fills anything yet.

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

- The extension proper: `manifest.json`, content script, MV3 packaging scoped
  to a single insurer host.
- `fill_mode: "web"` in `FormSchema`, with label-based match keys.
- The fill path. Note for whoever writes it: setting `input.value` directly
  does nothing on a React or Angular portal — the framework holds its own
  state, sees no event, and submits the old value. Use the native setter plus
  a bubbling `input` event. It fails *visibly correct*, which is the worst
  kind.
- Fill must never submit. The doctor clicks submit and signs, unchanged.
