# The AIA form, and the three things it breaks

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

## What that buys

`activeTab` and the injected content script are torn down by *navigation*, and
there is none until review. So one icon click covers steps 1 → 4. The
`optional_host_permissions` declared in `manifest.json` "for access that
survives a wizard step" turns out to be **unnecessary** — do not request it
without a new reason.

## What that breaks — problem 1: identification runs too early

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

## What that breaks — problem 2: the fill guard refuses a partial step

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

## What that breaks — problem 3: dropdowns and yes/no answers

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

## All three are still gated on the same thing

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
